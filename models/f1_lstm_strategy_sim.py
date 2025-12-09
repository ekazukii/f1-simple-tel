
"""
F1 LSTM Strategy Simulator
==========================

This module trains an LSTM model on lap-by-lap data to predict lap times,
then simulates races given user strategies (pits, compounds), safety cars, DNFs, and weather.

It auto-detects column names commonly found in FastF1 exports, builds variable-length sequences
per driver per race, and uses masked LSTM training.

Dependencies:
- pandas, numpy, scikit-learn, joblib
- tensorflow>=2.9 (Keras)

Usage
-----
Train:
  python f1_lstm_strategy_sim.py --csv /path/to/fastf1_lap_dataset.csv --train --save_dir /path/to/f1_lstm_model

Simulate with a trained model:
  python f1_lstm_strategy_sim.py --csv /path/to/fastf1_lap_dataset.csv --load_dir /path/to/f1_lstm_model --demo

Programmatic:
  from f1_lstm_strategy_sim import LSTMLapTimeModel, LSTMSimulator, RaceConfig, DriverSpec, PitEvent
  model = LSTMLapTimeModel().fit_from_csv(csv_path)
  sim = LSTMSimulator(model)
  result = sim.simulate(config)

Notes
-----
- Pit laps are excluded from training. The simulator adds pit loss time explicitly.
- Safety car laps are included in training so the model learns the pace reduction when is_sc=True.
- Unseen categorical values are mapped to a special "UNK" token at inference time.
"""

import argparse
import json
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple, Any

import numpy as np
import pandas as pd
import joblib

from sklearn.model_selection import train_test_split

import tensorflow as tf
from tensorflow import keras
from tensorflow.keras import layers


# -----------------------------
# Column detection
# -----------------------------

CANDIDATES = {
    "driver": ["driver", "Driver", "DriverRef", "DriverId", "driver_id", "DriverNumber", "DriverCode"],
    "team": ["team", "Team", "Constructor", "constructor_name", "ConstructorRef", "ConstructorId"],
    "circuit": ["circuit", "Circuit", "track", "Track", "EventName", "race_name", "RaceName", "CircuitName"],
    "session_key": ["SessionKey", "session_key", "raceId", "RaceId"],
    "lap_number": ["lap", "Lap", "LapNo", "LapNumber", "lap_number"],
    "lap_time_s": ["lap_time_s", "LapTimeSeconds", "LapTime_Sec", "LapTimeSec", "LapTimeSecondsFloat"],
    "lap_time_ms": ["LapTimeMillis", "lap_time_ms", "LapTimeMs"],
    "lap_time_str": ["LapTime", "Time", "LapTimeString"],
    "compound": ["compound", "Compound", "Tyre", "TyreCompound", "tyre_compound"],
    "tyre_age": ["tyre_age", "TyreLife", "LapsSincePit", "laps_on_current_tyre", "StintLap", "TyreAge", "TyreLap"],
    "position": ["Position", "position", "PositionOrder", "CurrentPosition"],
    "gap_to_ahead": ["GapToAhead", "gap_to_ahead_s", "GapAheadSec"],
    "air_temp": ["air_temp", "AirTemp", "AirTemperature"],
    "track_temp": ["track_temp", "TrackTemp", "TrackTemperature"],
    "humidity": ["humidity", "Humidity"],
    "wind_speed": ["wind_speed", "WindSpeed"],
    "wind_dir": ["wind_direction", "WindDirection"],
    "rain": ["is_rain", "Rain", "Rainfall", "RainfallMm"],
    "track_status": ["TrackStatus", "track_status"],
    "is_sc": ["is_sc", "SafetyCar", "SC", "sc_lap"],
    "is_vsc": ["is_vsc", "VirtualSafetyCar", "VSC", "vsc_lap"],
}

def find_col(df: pd.DataFrame, keys: List[str]) -> Optional[str]:
    cols = set(df.columns)
    for k in keys:
        if k in cols:
            return k
    # case-insensitive
    low = {c.lower(): c for c in df.columns}
    for k in keys:
        if k.lower() in low:
            return low[k.lower()]
    return None

def parse_lap_time_str_to_seconds(s: str) -> Optional[float]:
    if pd.isna(s):
        return None
    s = str(s).strip()
    try:
        if ":" in s:
            m, sec = s.split(":")
            return int(m) * 60.0 + float(sec)
        return float(s)
    except Exception:
        return None

def load_and_prepare(csv_path: str):
    df = pd.read_csv(csv_path)
    mapping = {}

    for key in ["driver","team","circuit","session_key","lap_number","compound"]:
        mapping[key] = find_col(df, CANDIDATES[key])

    # lap time
    lap_time_col = find_col(df, CANDIDATES["lap_time_s"])
    if lap_time_col is None:
        lt_ms = find_col(df, CANDIDATES["lap_time_ms"])
        if lt_ms is not None:
            df["lap_time_s_auto"] = df[lt_ms] / 1000.0
            lap_time_col = "lap_time_s_auto"
        else:
            lt_str = find_col(df, CANDIDATES["lap_time_str"])
            if lt_str is not None:
                df["lap_time_s_auto"] = df[lt_str].apply(parse_lap_time_str_to_seconds)
                lap_time_col = "lap_time_s_auto"
    if lap_time_col is None:
        raise ValueError("No lap time column found")
    mapping["lap_time_s"] = lap_time_col

    # optional numeric
    for key in ["tyre_age","position","gap_to_ahead","air_temp","track_temp","humidity","wind_speed","wind_dir","rain","track_status","is_sc","is_vsc"]:
        mapping[key] = find_col(df, CANDIDATES[key])

    # clean
    # numeric conversion for lap number
    if mapping["lap_number"] is not None:
        df[mapping["lap_number"]] = pd.to_numeric(df[mapping["lap_number"]], errors="coerce")

    # derive tyre age if missing
    if mapping["tyre_age"] is None and mapping["driver"] and mapping["circuit"] and mapping["lap_number"]:
        df = df.sort_values([mapping["driver"], mapping["circuit"], mapping["lap_number"]])
        ages = []
        last_cmpd = {}
        for idx, r in df.iterrows():
            key = (r[mapping["driver"]], r[mapping["circuit"]])
            cmpd = r[mapping["compound"]] if mapping["compound"] else None
            if key not in last_cmpd or last_cmpd[key] != cmpd:
                ages.append(0)
                last_cmpd[key] = cmpd
            else:
                ages.append( (ages[-1] if ages else 0) + 1 )
        df["tyre_age_auto"] = ages
        mapping["tyre_age"] = "tyre_age_auto"

    # SC/VSC from track status if not present
    if mapping["is_sc"] is None and mapping["track_status"] is not None:
        ts = df[mapping["track_status"]].astype(str)
        df["is_sc_auto"] = ts.str.contains("4")
        df["is_vsc_auto"] = ts.str.contains("5")
        mapping["is_sc"] = "is_sc_auto"
        mapping["is_vsc"] = "is_vsc_auto"

    # rain to boolean if numeric
    if mapping["rain"] is not None and df[mapping["rain"]].dtype.kind in "iufc":
        df["is_rain_bool"] = df[mapping["rain"]].fillna(0) > 0
        mapping["rain"] = "is_rain_bool"

    # filter lap times
    lt = df[mapping["lap_time_s"]]
    df = df[(lt > 25) & (lt < 300)].copy()

    # infer pit this lap
    df["pit_this_lap"] = False
    if mapping["driver"] and mapping["circuit"] and mapping["lap_number"]:
        df = df.sort_values([mapping["driver"], mapping["circuit"], mapping["session_key"] or mapping["circuit"], mapping["lap_number"]])
        grp = df.groupby([c for c in [mapping["driver"], mapping["circuit"], mapping["session_key"]] if c], sort=False)
        if mapping["compound"]:
            df["comp_prev"] = grp[mapping["compound"]].shift(1)
            df["pit_by_comp"] = df[mapping["compound"]] != df["comp_prev"]
        else:
            df["pit_by_comp"] = False
        if mapping["tyre_age"]:
            df["age_prev"] = grp[mapping["tyre_age"]].shift(1)
            df["pit_by_age"] = df[mapping["tyre_age"]] <= df["age_prev"]
        else:
            df["pit_by_age"] = False
        df["pit_this_lap"] = df["pit_by_comp"].fillna(False) | df["pit_by_age"].fillna(False)
        df.drop(columns=["comp_prev","age_prev"], errors="ignore", inplace=True)

    return df.reset_index(drop=True), mapping


# -----------------------------
# Sequence builder
# -----------------------------

NUMERIC_KEYS_ORDER = ["lap_number","tyre_age","position","gap_to_ahead","air_temp","track_temp","humidity","wind_speed","is_sc","is_vsc","rain"]

class SeqPreprocessor:
    def __init__(self):
        self.mapping: Dict[str, str] = {}
        self.cat_maps: Dict[str, Dict[str,int]] = {}
        self.numeric_means: Dict[str, float] = {}
        self.numeric_stds: Dict[str, float] = {}
        self.num_cols: List[str] = []
        self.cat_cols: List[str] = []
        self.max_len: int = 0

    @staticmethod
    def _build_index(values: List[str]) -> Dict[str,int]:
        # 0 is padding, 1 is UNK, others start at 2
        uniq = ["<PAD>","<UNK>"] + sorted([v for v in pd.unique(values) if pd.notna(v)])
        return {v:i for i,v in enumerate(uniq)}

    def fit(self, df: pd.DataFrame, mapping: Dict[str,str]):
        self.mapping = mapping
        # categorical maps
        cat_keys = ["driver","team","circuit","compound"]
        for k in cat_keys:
            col = mapping.get(k)
            if col is None:
                # fallback single token
                self.cat_maps[k] = {"<PAD>":0,"<UNK>":1,"UNK":2}
            else:
                self.cat_maps[k] = self._build_index(df[col].astype(str).tolist())
        self.cat_cols = cat_keys

        # numeric columns present
        present = []
        for k in NUMERIC_KEYS_ORDER:
            col = mapping.get(k)
            if col is not None and col in df:
                present.append(k)
        self.num_cols = present

        # mean/std on non-pit rows
        base = df[df["pit_this_lap"] == False]
        for k in self.num_cols:
            col = mapping[k]
            x = pd.to_numeric(base[col], errors="coerce")
            m = float(x.mean(skipna=True)) if x.notna().any() else 0.0
            s = float(x.std(skipna=True)) if x.notna().any() else 1.0
            if s == 0 or not np.isfinite(s):
                s = 1.0
            self.numeric_means[k] = m
            self.numeric_stds[k] = s

        # estimate max sequence length
        group_cols = [c for c in [mapping.get("driver"), mapping.get("circuit"), mapping.get("session_key")] if c]
        if not group_cols:
            group_cols = [mapping.get("driver"), mapping.get("circuit")]
        counts = df[df["pit_this_lap"] == False].groupby(group_cols).size()
        self.max_len = int(counts.max()) if len(counts) else 60

    def _idx(self, key: str, val: Any) -> int:
        m = self.cat_maps[key]
        if val is None or (isinstance(val, float) and np.isnan(val)):
            return 1  # UNK
        s = str(val)
        return m.get(s, 1)

    def _num(self, key: str, val: Any) -> float:
        if val is None or (isinstance(val, float) and not np.isfinite(val)):
            val = self.numeric_means.get(key, 0.0)
        col_mean = self.numeric_means.get(key, 0.0)
        col_std = self.numeric_stds.get(key, 1.0)
        return float((float(val) - col_mean) / col_std)

    def build_group_sequences(self, df: pd.DataFrame) -> Tuple[Dict[str,np.ndarray], np.ndarray, List[int]]:
        """
        Returns model inputs dict, targets array, and list of true lengths per sequence.
        Sequences are built per (driver,circuit,session) with pit laps removed.
        """
        mapping = self.mapping
        group_cols = [c for c in [mapping.get("driver"), mapping.get("circuit"), mapping.get("session_key")] if c]
        if not group_cols:
            group_cols = [mapping.get("driver"), mapping.get("circuit")]

        # prepare groups
        base = df[df["pit_this_lap"] == False].copy()
        if mapping.get("lap_number") is not None:
            base = base.sort_values(group_cols + [mapping["lap_number"]])
        else:
            base = base.sort_values(group_cols)

        seqs = []
        yseqs = []
        lengths = []

        # arrays will be padded to max_len
        maxlen = self.max_len

        for _, g in base.groupby(group_cols):
            # drop rows without target
            g = g[pd.notna(g[mapping["lap_time_s"]])]
            if g.empty:
                continue

            # Build per-timestep lists
            drv_idx = [self._idx("driver", v) for v in g[mapping["driver"]].astype(str)]
            team_idx = [self._idx("team", v) for v in g[mapping["team"]].astype(str)] if mapping.get("team") else [self._idx("team", "UNK")] * len(g)
            circ_idx = [self._idx("circuit", v) for v in g[mapping["circuit"]].astype(str)]
            comp_idx = [self._idx("compound", v) for v in g[mapping["compound"]].astype(str)] if mapping.get("compound") else [self._idx("compound", "UNK")] * len(g)

            # numeric
            num_steps = []
            for _, r in g.iterrows():
                step = []
                for k in self.num_cols:
                    col = mapping[k]
                    step.append(self._num(k, r[col]))
                num_steps.append(step)

            y = g[mapping["lap_time_s"]].astype(float).values

            L = len(y)
            lengths.append(L)

            # pad
            def pad_list(lst, pad_val):
                return lst + [pad_val] * (maxlen - len(lst))

            drv = pad_list(drv_idx, 0)
            team = pad_list(team_idx, 0)
            circ = pad_list(circ_idx, 0)
            comp = pad_list(comp_idx, 0)
            num = num_steps + [[0.0]*len(self.num_cols)] * (maxlen - len(num_steps))
            ypad = list(y) + [0.0] * (maxlen - L)

            seqs.append((drv, team, circ, comp, num))
            yseqs.append(ypad)

        if not seqs:
            raise ValueError("No sequences built from dataset. Check column mappings.")

        drv_arr = np.array([s[0] for s in seqs], dtype=np.int32)
        team_arr = np.array([s[1] for s in seqs], dtype=np.int32)
        circ_arr = np.array([s[2] for s in seqs], dtype=np.int32)
        comp_arr = np.array([s[3] for s in seqs], dtype=np.int32)
        num_arr = np.array([s[4] for s in seqs], dtype=np.float32)
        y_arr = np.array(yseqs, dtype=np.float32)

        inputs = {
            "driver_seq": drv_arr,
            "team_seq": team_arr,
            "circuit_seq": circ_arr,
            "compound_seq": comp_arr,
            "num_seq": num_arr,
        }
        return inputs, y_arr, lengths

    # Build a single sequence from a history of dict steps (for inference in sim)
    def build_single_inputs(self, hist_steps: List[Dict[str,Any]]) -> Dict[str,np.ndarray]:
        maxlen = self.max_len
        L = len(hist_steps)
        L = min(L, maxlen)
        steps = hist_steps[-L:]

        def get_val(step, key):
            # step keys are logical keys, not raw columns
            return step.get(key, None)

        drv_idx = [self._idx("driver", get_val(s,"driver")) for s in steps]
        team_idx = [self._idx("team", get_val(s,"team")) for s in steps]
        circ_idx = [self._idx("circuit", get_val(s,"circuit")) for s in steps]
        comp_idx = [self._idx("compound", get_val(s,"compound")) for s in steps]

        num_steps = []
        for s in steps:
            row = []
            for k in self.num_cols:
                row.append(self._num(k, get_val(s, k)))
            num_steps.append(row)

        # pad
        drv = drv_idx + [0]*(maxlen - L)
        team = team_idx + [0]*(maxlen - L)
        circ = circ_idx + [0]*(maxlen - L)
        comp = comp_idx + [0]*(maxlen - L)
        num = num_steps + [[0.0]*len(self.num_cols)]*(maxlen - L)

        inputs = {
            "driver_seq": np.array([drv], dtype=np.int32),
            "team_seq": np.array([team], dtype=np.int32),
            "circuit_seq": np.array([circ], dtype=np.int32),
            "compound_seq": np.array([comp], dtype=np.int32),
            "num_seq": np.array([num], dtype=np.float32),
        }
        return inputs


# -----------------------------
# Model
# -----------------------------

def build_lstm_model(cat_maps: Dict[str,Dict[str,int]], num_dim: int, max_len: int) -> keras.Model:
    # Inputs
    driver_in = keras.Input(shape=(max_len,), dtype="int32", name="driver_seq")
    team_in = keras.Input(shape=(max_len,), dtype="int32", name="team_seq")
    circuit_in = keras.Input(shape=(max_len,), dtype="int32", name="circuit_seq")
    compound_in = keras.Input(shape=(max_len,), dtype="int32", name="compound_seq")
    num_in = keras.Input(shape=(max_len, num_dim), dtype="float32", name="num_seq")

    # Embeddings with mask_zero=True to mask padding=0
    def emb(name, vocab):
        vocab_size = len(vocab)
        dim = min(32, max(8, vocab_size // 8))
        return layers.Embedding(vocab_size, dim, mask_zero=True, name=f"{name}_emb")

    drv_emb = emb("driver", cat_maps["driver"])(driver_in)
    team_emb = emb("team", cat_maps["team"])(team_in)
    circ_emb = emb("circuit", cat_maps["circuit"])(circuit_in)
    comp_emb = emb("compound", cat_maps["compound"])(compound_in)

    # Concatenate embeddings and numeric
    x = layers.Concatenate()([drv_emb, team_emb, circ_emb, comp_emb, num_in])

    # LSTM stack
    x = layers.Masking(mask_value=0.0)(x)  # extra safety for numeric zeros
    x = layers.Bidirectional(layers.LSTM(64, return_sequences=True))(x)
    x = layers.TimeDistributed(layers.Dense(64, activation="relu"))(x)
    out = layers.TimeDistributed(layers.Dense(1, activation="linear"), name="y")(x)

    model = keras.Model(inputs=[driver_in, team_in, circuit_in, compound_in, num_in], outputs=out)
    model.compile(optimizer=keras.optimizers.Adam(1e-3), loss="mae", metrics=["mae"])
    return model


class LSTMLapTimeModel:
    def __init__(self):
        self.prep = SeqPreprocessor()
        self.model: Optional[keras.Model] = None
        self.mapping: Dict[str,str] = {}
        self.pit_loss_by_circuit: Dict[str,float] = {}

    def fit_from_csv(self, csv_path: str, val_size: float=0.15, random_state: int=42, epochs: int=20, batch_size: int=32):
        df, mapping = load_and_prepare(csv_path)
        self.mapping = mapping

        # estimate pit loss per circuit for simulator
        self.pit_loss_by_circuit = self._estimate_pit_loss(df, mapping)

        self.prep.fit(df, mapping)
        X, y, lengths = self.prep.build_group_sequences(df)

        # train/val split by sequences
        idx = np.arange(y.shape[0])
        tr_idx, va_idx = train_test_split(idx, test_size=val_size, random_state=random_state, shuffle=True)

        def subset(X, idxs):
            return {k: v[idxs] for k,v in X.items()}

        X_tr, y_tr = subset(X, tr_idx), y[tr_idx]
        X_va, y_va = subset(X, va_idx), y[va_idx]

        model = build_lstm_model(self.prep.cat_maps, len(self.prep.num_cols), self.prep.max_len)
        cb = [
            keras.callbacks.EarlyStopping(monitor="val_mae", patience=4, restore_best_weights=True),
            keras.callbacks.ReduceLROnPlateau(monitor="val_mae", factor=0.5, patience=2, min_lr=1e-5),
        ]
        model.fit(X_tr, y_tr[..., None], validation_data=(X_va, y_va[..., None]), epochs=epochs, batch_size=batch_size, verbose=2, callbacks=cb)
        self.model = model
        return self

    def predict_sequence(self, steps: List[Dict[str,Any]]) -> np.ndarray:
        if self.model is None:
            raise ValueError("Model not loaded or trained")
        X = self.prep.build_single_inputs(steps)
        yhat = self.model.predict(X, verbose=0)
        # return 1D array of predictions for each timestep, take last index as latest prediction
        return yhat[0, :, 0]

    def save(self, save_dir: str):
        if self.model is None:
            raise ValueError("No model to save")
        Path(save_dir).mkdir(parents=True, exist_ok=True)
        # save keras model
        self.model.save(str(Path(save_dir) / "model.keras"))
        # save preprocessor and artifacts
        payload = {
            "mapping": self.prep.mapping,
            "cat_maps": self.prep.cat_maps,
            "numeric_means": self.prep.numeric_means,
            "numeric_stds": self.prep.numeric_stds,
            "num_cols": self.prep.num_cols,
            "cat_cols": self.prep.cat_cols,
            "max_len": self.prep.max_len,
            "pit_loss_by_circuit": self.pit_loss_by_circuit,
        }
        joblib.dump(payload, str(Path(save_dir) / "prep.joblib"))

    def load(self, load_dir: str):
        self.model = keras.models.load_model(str(Path(load_dir) / "model.keras"))
        payload = joblib.load(str(Path(load_dir) / "prep.joblib"))
        self.prep = SeqPreprocessor()
        self.prep.mapping = payload["mapping"]
        self.prep.cat_maps = payload["cat_maps"]
        self.prep.numeric_means = payload["numeric_means"]
        self.prep.numeric_stds = payload["numeric_stds"]
        self.prep.num_cols = payload["num_cols"]
        self.prep.cat_cols = payload["cat_cols"]
        self.prep.max_len = payload["max_len"]
        self.mapping = self.prep.mapping
        self.pit_loss_by_circuit = payload.get("pit_loss_by_circuit", {})

    def _estimate_pit_loss(self, df: pd.DataFrame, mapping: Dict[str,str]) -> Dict[str,float]:
        circ_col = mapping.get("circuit")
        lt_col = mapping["lap_time_s"]
        pit_loss = {}
        if circ_col is None:
            return pit_loss
        for circ, g in df.groupby(circ_col):
            base = g[g["pit_this_lap"] == False]
            pits = g[g["pit_this_lap"] == True]
            if base.empty or pits.empty:
                continue
            med_base = base[lt_col].median()
            loss = (pits[lt_col] - med_base).median()
            if pd.notna(loss) and 5 < loss < 60:
                pit_loss[str(circ)] = float(loss)
        return pit_loss


# -----------------------------
# Simulation
# -----------------------------

@dataclass
class DriverSpec:
    name: str
    team: str
    grid: int
    start_compound: str

@dataclass
class PitEvent:
    lap: int
    compound: str

@dataclass
class RaceConfig:
    circuit: str
    total_laps: int
    drivers: List[DriverSpec]
    strategy: Dict[str, List[PitEvent]] = field(default_factory=dict)
    safety_cars: List[Tuple[int,int]] = field(default_factory=list)
    dnfs: List[Tuple[str,int]] = field(default_factory=list)
    weather_by_lap: Dict[int, Dict[str, Any]] = field(default_factory=dict)
    default_weather: Dict[str, Any] = field(default_factory=dict)
    default_pit_loss: float = 22.0

class LSTMSimulator:
    def __init__(self, model: LSTMLapTimeModel):
        if model.model is None:
            raise ValueError("Provide a trained/loaded LSTMLapTimeModel")
        self.model = model

    def _is_sc(self, lap: int, sc_windows: List[Tuple[int,int]]) -> bool:
        for a,b in sc_windows:
            if a <= lap <= b:
                return True
        return False

    def simulate(self, config: RaceConfig) -> Dict[str, Any]:
        prep = self.model.prep
        pit_loss = self.model.pit_loss_by_circuit.get(config.circuit, config.default_pit_loss)

        # State per driver
        state = {}
        history = {}
        for d in config.drivers:
            state[d.name] = {
                "team": d.team,
                "compound": d.start_compound,
                "tyre_age": 0,
                "total_time": 0.0,
                "grid": d.grid,
                "running": True,
            }
            history[d.name] = []

        order = sorted([d.name for d in config.drivers], key=lambda n: state[n]["grid"])

        # timeline
        timeline = []

        for lap in range(1, config.total_laps + 1):
            # DNFs
            for name, lap_dnf in config.dnfs:
                if lap_dnf == lap and state.get(name) and state[name]["running"]:
                    state[name]["running"] = False

            is_sc = self._is_sc(lap, config.safety_cars)

            # Build features per driver and predict lap times
            lap_times = {}
            for name in order:
                s = state[name]
                if not s["running"]:
                    continue

                will_pit = any(e.lap == lap for e in config.strategy.get(name, []))

                # Build current step logical features
                step = {
                    "driver": name,
                    "team": s["team"],
                    "circuit": config.circuit,
                    "compound": s["compound"],
                    "lap_number": lap,
                    "tyre_age": s["tyre_age"],
                    "is_sc": 1 if is_sc else 0,
                    "is_vsc": 0,
                    "rain": 1 if bool(config.default_weather.get("rain", False)) else 0,
                    "air_temp": config.default_weather.get("air_temp"),
                    "track_temp": config.default_weather.get("track_temp"),
                    "humidity": config.default_weather.get("humidity"),
                    "wind_speed": config.default_weather.get("wind_speed"),
                    # traffic features can be added here if available
                }
                if lap in config.weather_by_lap:
                    for k, v in config.weather_by_lap[lap].items():
                        step[k] = v

                # History + current step for sequence prediction
                hist = history[name] + [step]
                yhat_seq = self.model.predict_sequence(hist)
                yhat = float(yhat_seq[len(hist)-1])  # last step prediction

                if will_pit:
                    yhat += pit_loss

                lap_times[name] = yhat

            # update totals
            for name, t in lap_times.items():
                state[name]["total_time"] += t

            # update tyres and compounds
            for name in order:
                s = state[name]
                if not s["running"]:
                    continue
                if any(e.lap == lap for e in config.strategy.get(name, [])):
                    # change compound
                    new_c = [e.compound for e in config.strategy[name] if e.lap == lap][0]
                    s["compound"] = new_c
                    s["tyre_age"] = 0
                else:
                    s["tyre_age"] += 1

            # push current step to history
            for name in order:
                s = state[name]
                if not s["running"]:
                    continue
                # The step we added above had all needed features; append it now
                # Ensure compound and tyre_age reflect post-lap state for next iteration
                hist_step = {
                    "driver": name,
                    "team": s["team"],
                    "circuit": config.circuit,
                    "compound": s["compound"],
                    "lap_number": lap,
                    "tyre_age": s["tyre_age"],
                    "is_sc": 1 if is_sc else 0,
                    "is_vsc": 0,
                    "rain": 1 if bool(config.default_weather.get("rain", False)) else 0,
                    "air_temp": config.default_weather.get("air_temp"),
                    "track_temp": config.default_weather.get("track_temp"),
                    "humidity": config.default_weather.get("humidity"),
                    "wind_speed": config.default_weather.get("wind_speed"),
                }
                if lap in config.weather_by_lap:
                    for k, v in config.weather_by_lap[lap].items():
                        hist_step[k] = v
                history[name].append(hist_step)
                # trim history to max_len
                history[name] = history[name][-self.model.prep.max_len:]

            # reorder by total_time
            running = [n for n in order if state[n]["running"]]
            running_sorted = sorted(running, key=lambda n: state[n]["total_time"])
            dnfs = [n for n in order if not state[n]["running"]]
            order = running_sorted + dnfs

            timeline.append({
                "lap": lap,
                "order": running_sorted.copy(),
                "lap_times": lap_times.copy(),
                "is_sc": is_sc
            })

        # final classification
        classification = []
        pos = 1
        for name in order:
            s = state[name]
            if s["running"]:
                classification.append({"pos": pos, "driver": name, "team": s["team"], "total_time": s["total_time"], "status": "Finished"})
                pos += 1
        for name in order:
            s = state[name]
            if not s["running"]:
                classification.append({"pos": None, "driver": name, "team": s["team"], "total_time": s["total_time"], "status": "DNF"})

        return {
            "classification": classification,
            "timeline": timeline,
            "pit_loss_used": pit_loss,
        }


# -----------------------------
# Demo utilities
# -----------------------------

def demo_config_from_dataset(df: pd.DataFrame, mapping: Dict[str,str]) -> RaceConfig:
    circ_col = mapping.get("circuit")
    if circ_col is None:
        raise ValueError("Circuit column missing")
    circuit = df[circ_col].dropna().astype(str).mode().iloc[0]

    drv_col = mapping.get("driver")
    team_col = mapping.get("team")
    cmp_col = mapping.get("compound")
    lap_col = mapping.get("lap_number")

    sub = df[df[circ_col] == circuit].copy()
    if lap_col in sub:
        sub = sub.sort_values(lap_col)
    first = sub.groupby(drv_col).first()
    drivers = []
    for i, (drv, row) in enumerate(first.head(10).iterrows(), start=1):
        team = str(row[team_col]) if team_col else "Team"
        comp = str(row[cmp_col]) if cmp_col else "Medium"
        drivers.append(DriverSpec(name=str(drv), team=team, grid=i, start_compound=comp))

    total_laps = int(sub[lap_col].max()) if lap_col is not None and pd.notna(sub[lap_col].max()) else 50

    def med(col, default=None):
        if mapping.get(col) and mapping[col] in sub:
            v = sub[mapping[col]].median()
            return float(v) if pd.notna(v) else default
        return default

    default_weather = {
        "air_temp": med("air_temp", 25.0),
        "track_temp": med("track_temp", 35.0),
        "humidity": med("humidity", 50.0),
        "wind_speed": med("wind_speed", 2.0),
        "rain": False,
    }

    return RaceConfig(
        circuit=str(circuit),
        total_laps=total_laps,
        drivers=drivers,
        strategy={},
        safety_cars=[],
        dnfs=[],
        weather_by_lap={},
        default_weather=default_weather,
    )


# -----------------------------
# CLI
# -----------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True, help="Path to fastf1_lap_dataset.csv")
    parser.add_argument("--train", action="store_true", help="Train LSTM model")
    parser.add_argument("--save_dir", type=str, default="f1_lstm_model", help="Directory to save model artifacts")
    parser.add_argument("--load_dir", type=str, help="Directory to load model artifacts")
    parser.add_argument("--demo", action="store_true", help="Run a demo simulation on a frequent circuit")
    parser.add_argument("--epochs", type=int, default=15)
    parser.add_argument("--batch_size", type=int, default=32)
    args = parser.parse_args()

    df, mapping = load_and_prepare(args.csv)

    model = LSTMLapTimeModel()

    if args.train or not args.load_dir:
        model.fit_from_csv(args.csv, epochs=args.epochs, batch_size=args.batch_size)
        model.save(args.save_dir)
        print(f"Saved LSTM model to {args.save_dir}")
    else:
        model.load(args.load_dir)
        print(f"Loaded LSTM model from {args.load_dir}")

    if args.demo:
        cfg = demo_config_from_dataset(df, mapping)
        sim = LSTMSimulator(model)
        result = sim.simulate(cfg)
        print("Pit loss used:", result["pit_loss_used"])
        print("Final classification:")
        for row in result["classification"]:
            pos = row["pos"] if row["pos"] is not None else "DNF"
            print(f"{pos}: {row['driver']} ({row['team']})  total_time={row['total_time']:.2f}  status={row['status']}")

        print("\nFirst 3 laps timeline:")
        for item in result["timeline"][:3]:
            print(json.dumps(item, indent=2))

if __name__ == "__main__":
    main()
