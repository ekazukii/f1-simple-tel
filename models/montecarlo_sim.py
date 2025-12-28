from __future__ import annotations

from pathlib import Path
import argparse
import json
from datetime import datetime, timezone

import joblib
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import torch
from tqdm.auto import tqdm


class CleanPaceModel(torch.nn.Module):
    def __init__(self, vocab_sizes, spline_dim, weather_dim):
        super().__init__()
        self.driver_emb = torch.nn.Embedding(vocab_sizes["driver"], 16)
        self.team_emb = torch.nn.Embedding(vocab_sizes["team"], 8)
        self.circuit_emb = torch.nn.Embedding(vocab_sizes["circuit"], 12)
        self.year_emb = torch.nn.Embedding(vocab_sizes["year"], 4)
        self.session_emb = torch.nn.Embedding(vocab_sizes["session"], 8)
        self.compound_emb = torch.nn.Embedding(vocab_sizes["compound"], 4)

        base_in = 16 + 8 + 12 + 4 + 8
        self.base_linear = torch.nn.Linear(base_in, 1)

        self.fuel_linear = torch.nn.Linear(12, 1)
        self.track_linear = torch.nn.Linear(8, spline_dim)

        tyre_in = 4 + 12 + weather_dim + 1
        self.tyre_mlp = torch.nn.Sequential(
            torch.nn.Linear(tyre_in, 32),
            torch.nn.ReLU(),
            torch.nn.Linear(32, 4),
        )

        self.weather_mlp = torch.nn.Sequential(
            torch.nn.Linear(weather_dim, 16),
            torch.nn.ReLU(),
            torch.nn.Linear(16, 1),
        )

        self.age_norm_weight = torch.nn.Parameter(torch.tensor(0.0))
        self.age_over_weight = torch.nn.Parameter(torch.tensor(0.0))
        self.bias = torch.nn.Parameter(torch.zeros(1))

    def forward(self, batch):
        (
            driver_id, team_id, circuit_id, year_id, session_id, compound_id, driver_weight,
            laps_remaining_norm, tyre_age, age_norm, age_over_norm, expected_len, lap_spline, weather
        ) = batch

        driver_emb_raw = self.driver_emb(driver_id)
        unk_id = torch.zeros_like(driver_id)
        driver_emb_unk = self.driver_emb(unk_id)
        w = driver_weight.unsqueeze(1).clamp(0.0, 1.0)
        driver_emb = w * driver_emb_raw + (1.0 - w) * driver_emb_unk
        team_emb = self.team_emb(team_id)
        circuit_emb = self.circuit_emb(circuit_id)
        year_emb = self.year_emb(year_id)
        session_emb = self.session_emb(session_id)
        compound_emb = self.compound_emb(compound_id)

        base = self.base_linear(torch.cat([driver_emb, team_emb, circuit_emb, year_emb, session_emb], dim=1)).squeeze(1)

        fuel_k = torch.nn.functional.softplus(self.fuel_linear(circuit_emb).squeeze(1))
        fuel = fuel_k * laps_remaining_norm

        track_weights = self.track_linear(session_emb)
        track_evo = (lap_spline * track_weights).sum(dim=1)

        expected_len = torch.clamp(expected_len, min=1e-6)
        tyre_context = torch.cat([compound_emb, circuit_emb, weather, expected_len.unsqueeze(1)], dim=1)
        tyre_params = self.tyre_mlp(tyre_context)
        a = torch.nn.functional.softplus(tyre_params[:, 0])
        b = torch.nn.functional.softplus(tyre_params[:, 1])
        c = torch.nn.functional.softplus(tyre_params[:, 2])
        tau = torch.nn.functional.softplus(tyre_params[:, 3])
        age_term = a * tyre_age + b * (tyre_age ** 2)
        knee = torch.nn.functional.softplus(tyre_age - tau)
        tyre_deg = age_term + c * (knee ** 2)

        extra_age = torch.nn.functional.softplus(self.age_norm_weight) * age_norm
        extra_over = torch.nn.functional.softplus(self.age_over_weight) * age_over_norm

        weather_term = self.weather_mlp(weather).squeeze(1)

        pred = base + fuel + track_evo + tyre_deg + weather_term + extra_age + extra_over + self.bias
        return pred


class TrafficModel(torch.nn.Module):
    def __init__(self, circuit_vocab_size):
        super().__init__()
        self.circuit_emb = torch.nn.Embedding(circuit_vocab_size, 6)
        self.pmax_linear = torch.nn.Linear(6, 1)
        self.g0_linear = torch.nn.Linear(6, 1)
        self.s_raw = torch.nn.Parameter(torch.tensor(0.5))
        self.drs_raw = torch.nn.Parameter(torch.tensor(0.0))

    def forward(self, circuit_id, gap_ahead, drs):
        cemb = self.circuit_emb(circuit_id)
        pmax = torch.nn.functional.softplus(self.pmax_linear(cemb).squeeze(1))
        g0 = torch.nn.functional.softplus(self.g0_linear(cemb).squeeze(1))
        s = torch.nn.functional.softplus(self.s_raw) + 1e-3
        delta_drs = torch.sigmoid(self.drs_raw)
        penalty = pmax * torch.sigmoid((g0 - gap_ahead) / s)
        penalty = penalty * (1 - delta_drs * drs)
        return penalty


class MonteCarloSimulator:
    def __init__(
        self,
        base_dir=None,
        bundle_path=None,
        data_path=None,
        overtake_path=None,
        dnf_path=None,
        safety_path=None,
        noise_scale=0.5,
        verbose=False,
    ):
        base_dir = Path(base_dir) if base_dir is not None else Path(__file__).resolve().parent.parent
        if base_dir.name == "models":
            base_dir = base_dir.parent

        if bundle_path is None:
            bundle_path = base_dir / "models" / "laptime_model_bundle.joblib"
        if not Path(bundle_path).exists():
            raise FileNotFoundError(f"Missing bundle at {bundle_path}")

        bundle = joblib.load(bundle_path)

        self.cat_vocabs = bundle["cat_vocabs"]
        self.weather_scaler = bundle["weather_scaler"]
        self.spline = bundle["spline"]
        self.stint_stats = bundle["stint_stats"]
        self.expected_global = float(bundle.get("expected_global", 15.0))
        self.circuit_median_map = bundle.get("circuit_median_map", {})
        self.global_median_lap = float(bundle.get("global_median_lap", 90.0))
        self.driver_counts = bundle.get("driver_counts", {})
        self.driver_shrink_k = float(bundle.get("driver_shrink_k", 2000.0))
        self.track_cols = bundle.get("track_cols", [
            "track_temperature",
            "air_temperature",
            "humidity",
            "pressure",
            "wind_speed",
            "wind_direction",
        ])
        self.weather_cols = bundle.get("weather_cols", self.track_cols + ["wet"])
        self.clean_gap_threshold = float(bundle.get("clean_gap_threshold", 2.5))
        self.pit_loss_map = bundle.get("pit_loss_map", {})
        self.pit_loss_mean_global = float(
            np.mean([v.get("pit_loss_mean", 0.0) for v in self.pit_loss_map.values()]) or 20.0
        ) if self.pit_loss_map else 20.0
        self.pit_loss_std_global = float(
            np.mean([v.get("pit_loss_std", 0.0) for v in self.pit_loss_map.values() if v.get("pit_loss_std") is not None])
        ) if self.pit_loss_map else 0.0
        if not np.isfinite(self.pit_loss_std_global):
            self.pit_loss_std_global = 0.0

        pit_loss_floor_vals = [
            v.get("pit_loss_floor")
            for v in self.pit_loss_map.values()
            if v.get("pit_loss_floor") is not None and np.isfinite(v.get("pit_loss_floor"))
        ]
        self.pit_loss_floor_global = float(np.mean(pit_loss_floor_vals)) if pit_loss_floor_vals else max(0.0, self.pit_loss_mean_global - self.pit_loss_std_global)
        if not np.isfinite(self.pit_loss_floor_global) or self.pit_loss_floor_global < 0:
            self.pit_loss_floor_global = 0.0

        pit_loss_excess_mean_vals = [
            v.get("pit_excess_mean")
            for v in self.pit_loss_map.values()
            if v.get("pit_excess_mean") is not None and np.isfinite(v.get("pit_excess_mean"))
        ]
        self.pit_loss_excess_mean_global = float(np.mean(pit_loss_excess_mean_vals)) if pit_loss_excess_mean_vals else max(0.0, self.pit_loss_mean_global - self.pit_loss_floor_global)
        if not np.isfinite(self.pit_loss_excess_mean_global) or self.pit_loss_excess_mean_global < 0:
            self.pit_loss_excess_mean_global = max(0.0, self.pit_loss_mean_global - self.pit_loss_floor_global)

        pit_loss_excess_std_vals = [
            v.get("pit_excess_std")
            for v in self.pit_loss_map.values()
            if v.get("pit_excess_std") is not None and np.isfinite(v.get("pit_excess_std"))
        ]
        self.pit_loss_excess_std_global = float(np.mean(pit_loss_excess_std_vals)) if pit_loss_excess_std_vals else self.pit_loss_std_global
        if not np.isfinite(self.pit_loss_excess_std_global) or self.pit_loss_excess_std_global < 0:
            self.pit_loss_excess_std_global = 0.0

        self.noise_sigma_form = float(bundle.get("noise_sigma_form", 0.0))
        self.noise_rho = float(bundle.get("noise_rho", 0.0))
        self.noise_sigma_eta = float(bundle.get("noise_sigma_eta", 0.0))
        self.noise_scale = max(0.0, float(noise_scale))

        self.spline_cols = [f"lap_spline_{i}" for i in range(self.spline.n_features_out_)]
        self.weather_scaled_cols = [c + "_scaled" for c in self.weather_cols]

        vocab_sizes = {
            "driver": len(self.cat_vocabs["driver_id"]) + 1,
            "team": len(self.cat_vocabs["team_id"]) + 1,
            "circuit": len(self.cat_vocabs["circuit_id"]) + 1,
            "year": len(self.cat_vocabs["year"]) + 1,
            "session": len(self.cat_vocabs["session_key"]) + 1,
            "compound": len(self.cat_vocabs["tyre_compound"]) + 1,
        }

        self.device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
        self.clean_model = CleanPaceModel(vocab_sizes, spline_dim=len(self.spline_cols), weather_dim=len(self.weather_scaled_cols)).to(self.device)
        self.clean_model.load_state_dict(bundle["clean_model_state_dict"])
        self.clean_model.eval()

        self.traffic_model = TrafficModel(vocab_sizes["circuit"]).to(self.device)
        self.traffic_model.load_state_dict(bundle["traffic_model_state_dict"])
        self.traffic_model.eval()

        csv_candidates = [
            Path("fastf1_lap_dataset.csv"),
            Path("models/fastf1_lap_dataset.csv"),
            base_dir / "fastf1_lap_dataset.csv",
            base_dir / "models" / "fastf1_lap_dataset.csv",
        ]
        if data_path is not None:
            csv_candidates.insert(0, Path(data_path))
        csv_path = next((p for p in csv_candidates if p.exists()), None)
        if csv_path is None:
            raise FileNotFoundError("fastf1_lap_dataset.csv not found")

        self.df = pd.read_csv(csv_path)

        for col in ["safety_car_this_lap", "virtual_sc_this_lap"]:
            if col in self.df.columns:
                self.df[col] = self.df[col].fillna(False).astype(bool)
            else:
                self.df[col] = False

        skill_df = self.df[(~self.df["safety_car_this_lap"]) & (~self.df["virtual_sc_this_lap"]) & self.df["lap_time_s"].notna()].copy()

        session_stats = (
            skill_df
            .groupby("session_key")["lap_time_s"]
            .agg(session_median_lap="median", session_std_lap="std")
            .reset_index()
        )

        skill_df = skill_df.merge(session_stats, on="session_key", how="left")
        skill_df["session_std_lap"] = skill_df["session_std_lap"].replace(0, np.nan)
        skill_df["session_perf_z"] = -(
            skill_df["lap_time_s"] - skill_df["session_median_lap"]
        ) / skill_df["session_std_lap"]
        skill_df["session_perf_z"] = skill_df["session_perf_z"].fillna(0.0)

        driver_skill_raw = skill_df.groupby("driver_id")["session_perf_z"].mean()
        driver_skill = (driver_skill_raw - driver_skill_raw.mean()) / driver_skill_raw.std()
        self.driver_skill_map = driver_skill.fillna(0.0).to_dict()

        self.driver_team_map = self.df.groupby("driver_id")["team_id"].apply(self._mode_or_first).to_dict()
        self.team_by_year = self.df.groupby(["year", "driver_id"])["team_id"].apply(self._mode_or_first).to_dict()
        self.team_by_session = self.df.groupby(["session_key", "driver_id"])["team_id"].apply(self._mode_or_first).to_dict()

        self.session_key_map = (
            self.df
            .groupby(["circuit_id", "year"])["session_key"]
            .apply(self._mode_or_first)
            .to_dict()
        )

        self.default_session_key = self._mode_or_first(self.df["session_key"])
        self.session_vocab = self.cat_vocabs["session_key"]
        if self.default_session_key not in self.session_vocab:
            candidates = [k for k in self.session_vocab.keys() if k != "__UNK__"]
            self.default_session_key = candidates[0] if candidates else "__UNK__"

        self.weather_defaults = {}
        for col in self.track_cols:
            if col in self.df.columns:
                self.weather_defaults[col] = float(pd.to_numeric(self.df[col], errors="coerce").median())
            else:
                self.weather_defaults[col] = 0.0

        last_session_key = self.df["session_key"].iloc[-1000]
        grid_source = self.df[self.df["session_key"] == last_session_key]
        first_lap_rows = grid_source[grid_source["lap_number"] == grid_source["lap_number"].min()]
        self.grid_drivers = (
            first_lap_rows.sort_values("current_position")["driver_id"].drop_duplicates().tolist()
        )

        self.expected_stint_map = {}
        if "expected_stint_len" in self.stint_stats.columns:
            self.expected_stint_map = (
                self.stint_stats.set_index(["circuit_id", "tyre_compound"])["expected_stint_len"].to_dict()
            )

        self.circuits = self.df["circuit_id"].dropna().unique().tolist()
        self.years_by_circuit = self.df.groupby("circuit_id")["year"].unique().to_dict()

        self.master_rng = np.random.default_rng(12345)

        if overtake_path is None:
            overtake_path = base_dir / "models" / "overtaking_model.joblib"
        if not Path(overtake_path).exists():
            raise FileNotFoundError("Missing models/overtaking_model.joblib. Run models/overtaking_model.ipynb to train/export.")
        overtake_bundle = joblib.load(overtake_path)
        self.overtake_pipeline = overtake_bundle.get("pipeline")
        self.overtake_include_year = bool(overtake_bundle.get("include_year", True))
        self.overtake_gap_threshold = float(overtake_bundle.get("gap_threshold", 1.0))
        self.overtake_base_rate = float(overtake_bundle.get("base_rate", 0.05))

        if dnf_path is None:
            dnf_path = base_dir / "models" / "dnf_model.joblib"
        if not Path(dnf_path).exists():
            raise FileNotFoundError("Missing models/dnf_model.joblib. Run models/dnf_model.ipynb to train/export.")
        dnf_bundle = joblib.load(dnf_path)
        self.dnf_pipeline = dnf_bundle["pipeline"]
        self.dnf_include_year = bool(dnf_bundle.get("include_year", True))
        self.dnf_avg_total_laps = float(dnf_bundle.get("avg_total_laps", 50.0))

        if safety_path is None:
            safety_path = base_dir / "models" / "safety_car_model.joblib"
        if not Path(safety_path).exists():
            raise FileNotFoundError("Missing models/safety_car_model.joblib. Run models/safety_car_model.ipynb to train/export.")
        safety_bundle = joblib.load(safety_path)
        self.safety_pipeline = safety_bundle["pipeline"]
        self.safety_include_year = bool(safety_bundle.get("include_year", True))
        self.safety_max_len_bucket = int(safety_bundle.get("max_len_bucket", 12))

        if verbose:
            print(f"Loaded laptime model bundle from {bundle_path}")
            print(f"  noise_sigma_form: {self.noise_sigma_form}")
            print(f"  noise_rho: {self.noise_rho}")
            print(f"  noise_sigma_eta: {self.noise_sigma_eta}")
            print(f"Grid built from session {last_session_key}: {self.grid_drivers}")

    @staticmethod
    def _mode_or_first(series):
        if series.empty:
            return None
        modes = series.mode()
        if not modes.empty:
            return modes.iloc[0]
        return series.iloc[0]

    def _phase(self, progress):
        if progress < 0.33:
            return "early"
        if progress < 0.66:
            return "middle"
        return "late"

    def _encode_value(self, value, vocab):
        return vocab.get(str(value), vocab["__UNK__"])

    def lookup_session_key(self, circuit_id, year):
        key = self.session_key_map.get((circuit_id, year), self.default_session_key)
        if key not in self.session_vocab:
            key = self.default_session_key
        return key

    def predict_clean_and_traffic_fast(
        self,
        driver_id_ids,
        team_id_ids,
        circuit_id_ids,
        year_id_ids,
        session_id_ids,
        compound_ids,
        driver_weight,
        laps_remaining_norm,
        tyre_age,
        age_norm,
        age_over_norm,
        expected_len,
        lap_spline,
        weather_scaled,
        gap_ahead,
        drs,
    ):
        with torch.no_grad():
            features = [
                torch.tensor(driver_id_ids, dtype=torch.long, device=self.device),
                torch.tensor(team_id_ids, dtype=torch.long, device=self.device),
                torch.tensor(circuit_id_ids, dtype=torch.long, device=self.device),
                torch.tensor(year_id_ids, dtype=torch.long, device=self.device),
                torch.tensor(session_id_ids, dtype=torch.long, device=self.device),
                torch.tensor(compound_ids, dtype=torch.long, device=self.device),
                torch.tensor(driver_weight, dtype=torch.float32, device=self.device),
                torch.tensor(laps_remaining_norm, dtype=torch.float32, device=self.device),
                torch.tensor(tyre_age, dtype=torch.float32, device=self.device),
                torch.tensor(age_norm, dtype=torch.float32, device=self.device),
                torch.tensor(age_over_norm, dtype=torch.float32, device=self.device),
                torch.tensor(expected_len, dtype=torch.float32, device=self.device),
                torch.tensor(lap_spline, dtype=torch.float32, device=self.device),
                torch.tensor(weather_scaled, dtype=torch.float32, device=self.device),
            ]
            clean_pred = self.clean_model(features).detach().cpu().numpy()

            circuit_t = torch.tensor(circuit_id_ids, dtype=torch.long, device=self.device)
            gap_t = torch.tensor(gap_ahead, dtype=torch.float32, device=self.device)
            drs_t = torch.tensor(drs, dtype=torch.float32, device=self.device)
            traffic_pred = self.traffic_model(circuit_t, gap_t, drs_t).detach().cpu().numpy()

        return clean_pred, traffic_pred

    def overtake_success_probability(self, attacker_state, defender_state, circuit_id, gap_start, year=None):
        if self.overtake_pipeline is None:
            return float(np.clip(self.overtake_base_rate, 0.01, 0.95))

        def _safe_num(value, default=0.0):
            if value is None or pd.isna(value):
                return default
            return float(value)

        skill_att = float(self.driver_skill_map.get(attacker_state.get("driver_id"), 0.0))
        skill_def = float(self.driver_skill_map.get(defender_state.get("driver_id"), 0.0))
        skill_diff = skill_att - skill_def

        att_laps = _safe_num(attacker_state.get("laps_on_current_tyre", 0.0), 0.0)
        def_laps = _safe_num(defender_state.get("laps_on_current_tyre", att_laps), att_laps)
        tyre_adv_laps = def_laps - att_laps

        gap_value = _safe_num(gap_start, self.overtake_gap_threshold)

        feature_row = {
            "circuit_id": str(circuit_id) if circuit_id is not None else "unknown",
            "gap_start": float(max(gap_value, 0.0)),
            "tyre_age_diff": float(tyre_adv_laps),
            "skill_diff": float(skill_diff),
        }
        if self.overtake_include_year:
            if year is None or pd.isna(year):
                year_value = "unknown"
            else:
                try:
                    year_value = str(int(year))
                except (TypeError, ValueError):
                    year_value = str(year)
            feature_row["year"] = year_value

        X = pd.DataFrame([feature_row])
        prob = float(self.overtake_pipeline.predict_proba(X)[0, 1])
        return float(np.clip(prob, 0.01, 0.95))

    def apply_overtakes_for_lap(
        self,
        circuit_id,
        drivers_by_pos,
        lap_times,
        base_lap,
        year=None,
        close_gap_threshold=None,
        fail_gap=0.3,
        rng=None,
    ):
        lap_times = np.asarray(lap_times, dtype=float).copy()
        base_lap = float(base_lap)
        n = len(drivers_by_pos)

        overtake_attempts = np.zeros(n, dtype=bool)
        if close_gap_threshold is None:
            close_gap_threshold = self.overtake_gap_threshold

        rng = rng or self.master_rng

        for idx in range(1, n):
            follower = drivers_by_pos[idx]
            leader = drivers_by_pos[idx - 1]

            gap_start = float(follower["gap_to_ahead"])
            leader_time = lap_times[idx - 1]
            follower_time = lap_times[idx]
            gap_end_raw = gap_start + (follower_time - leader_time)

            going_to_pass_raw = gap_end_raw < 0.0
            close_enough = gap_start <= close_gap_threshold

            if not going_to_pass_raw and not close_enough:
                continue

            overtake_attempts[idx] = True

            margin = max(0.0, -gap_end_raw)
            p_success = self.overtake_success_probability(
                attacker_state=follower,
                defender_state=leader,
                circuit_id=circuit_id,
                gap_start=gap_start,
                year=year,
            )
            p_success = float(min(0.99, p_success + 0.15 * min(margin / 0.5, 1.0)))

            success = (rng.random() < p_success) and going_to_pass_raw
            if success:
                continue

            desired_follower_time = leader_time + fail_gap - gap_start
            if desired_follower_time > follower_time:
                lap_times[idx] = desired_follower_time

        pred_deltas = lap_times - base_lap
        return lap_times, pred_deltas, overtake_attempts

    def dnf_hazard(self, circuit_id, lap_number, year=None, total_race_laps=None):
        total_laps = float(total_race_laps) if total_race_laps else float(self.dnf_avg_total_laps or 1.0)
        lap_num = float(lap_number or 0)
        progress = lap_num / total_laps if total_laps > 0 else 0.0

        data = {
            "circuit_id": str(circuit_id) if circuit_id is not None else "unknown",
            "lap_number": lap_num,
            "total_race_laps": total_laps,
            "progress": progress,
        }
        if self.dnf_include_year:
            data["year"] = str(year) if year is not None else "unknown"
        X = pd.DataFrame([data])
        prob = float(self.dnf_pipeline.predict_proba(X)[0, 1])
        return float(np.clip(prob, 1e-6, 0.5))

    def apply_dnfs_for_lap(self, circuit_id, drivers_by_pos, lap_number, year=None, total_race_laps=None, rng=None):
        rng = rng or self.master_rng
        h = self.dnf_hazard(circuit_id, lap_number, year=year, total_race_laps=total_race_laps)
        dnfs_this_lap = []
        for driver in drivers_by_pos:
            if driver.get("dnf", False):
                dnfs_this_lap.append(False)
                continue
            dnf_now = bool(rng.random() < h)
            dnfs_this_lap.append(dnf_now)
            if dnf_now:
                driver["dnf"] = True
        return drivers_by_pos, dnfs_this_lap

    def sc_transition_probs(self, state, stint_len, circuit_id, year, progress, lap_number):
        stint_bucket = 0 if state == "green" else min(int(stint_len), self.safety_max_len_bucket)
        phase = self._phase(progress)
        row = {
            "state": state,
            "stint_bucket": float(stint_bucket),
            "race_progress": float(progress),
            "lap_number": float(lap_number),
            "circuit_id": str(circuit_id) if circuit_id is not None else "unknown",
            "phase": phase,
        }
        if self.safety_include_year:
            if year is None or pd.isna(year):
                year_value = "unknown"
            else:
                try:
                    year_value = str(int(year))
                except (TypeError, ValueError):
                    year_value = str(year)
            row["year"] = year_value
        else:
            row["year"] = "unknown"
        X = pd.DataFrame([row])
        probs = self.safety_pipeline.predict_proba(X)[0]
        class_map = dict(zip(self.safety_pipeline.classes_, probs))
        return {
            "green": float(class_map.get("green", 0.0)),
            "vsc": float(class_map.get("vsc", 0.0)),
            "sc": float(class_map.get("sc", 0.0)),
        }

    def sc_next_state(self, state, stint_len, circuit_id, year, progress, lap_number, rng=None):
        rng = rng or self.master_rng
        probs = self.sc_transition_probs(state, stint_len, circuit_id, year, progress, lap_number)
        r = rng.random()
        if r < probs["green"]:
            next_state = "green"
        elif r < probs["green"] + probs["vsc"]:
            next_state = "vsc"
        else:
            next_state = "sc"

        if next_state == state and state in ("vsc", "sc"):
            next_len = int(stint_len) + 1
        elif next_state in ("vsc", "sc"):
            next_len = 1
        else:
            next_len = 0
        return next_state, next_len

    def simulate_race(
        self,
        circuit_id,
        grid_drivers,
        total_laps=50,
        year=2025,
        global_strategy=None,
        driver_strategies=None,
        safety_car_laps=None,
        rain_laps=None,
        pit_loss=None,
        rng=None,
    ):
        rng = rng or np.random.default_rng()

        base_seed = int(rng.integers(0, 1_000_000_000))
        sc_rng = np.random.default_rng(base_seed + 2)
        overtake_rng = np.random.default_rng(base_seed + 3)
        dnf_rng = np.random.default_rng(base_seed + 4)
        pit_rng = np.random.default_rng(base_seed + 6)

        noise_by_driver = {}
        if self.noise_scale > 0 and (self.noise_sigma_form > 0 or self.noise_sigma_eta > 0):
            noise_rng = np.random.default_rng(base_seed + 5)
            for drv in grid_drivers:
                form = float(noise_rng.normal(0.0, self.noise_sigma_form * self.noise_scale))
                eps = 0.0
                lap_noise = []
                for _ in range(total_laps):
                    eps = self.noise_rho * eps + noise_rng.normal(0.0, self.noise_sigma_eta * self.noise_scale)
                    lap_noise.append(form + eps)
                noise_by_driver[drv] = lap_noise

        if global_strategy is None:
            raise ValueError("global_strategy must be provided, e.g. [(20, 'MEDIUM'), (40, 'SOFT')]")
        if driver_strategies is None:
            driver_strategies = {}

        if safety_car_laps is None:
            auto_sc_laps = set()
            state, stint_len = "green", 0
            for lap in range(1, total_laps + 1):
                if state == "sc":
                    auto_sc_laps.add(lap)
                progress = lap / total_laps
                state, stint_len = self.sc_next_state(state, stint_len, circuit_id, year, progress, lap, rng=sc_rng)
            safety_car_laps = auto_sc_laps
        else:
            safety_car_laps = set(safety_car_laps)

        if rain_laps is None:
            rain_laps = set()
        else:
            rain_laps = set(rain_laps)

        session_key = self.lookup_session_key(circuit_id, year)
        circuit_id_id = self._encode_value(circuit_id, self.cat_vocabs["circuit_id"])
        year_id = self._encode_value(year, self.cat_vocabs["year"])
        session_id = self._encode_value(session_key, self.cat_vocabs["session_key"])

        expected_by_compound = {
            comp: float(val)
            for (circuit, comp), val in self.expected_stint_map.items()
            if circuit == circuit_id
        }
        compound_vocab = self.cat_vocabs["tyre_compound"]

        lap_progress = np.arange(1, total_laps + 1) / total_laps
        lap_progress_df = pd.DataFrame({"lap_progress": lap_progress})
        spline_by_lap = self.spline.transform(lap_progress_df)
        laps_remaining_norm_by_lap = (total_laps - np.arange(1, total_laps + 1)) / total_laps

        weather_vals = []
        for col in self.weather_cols:
            if col == "wet":
                weather_vals.append(0.0)
            else:
                weather_vals.append(self.weather_defaults.get(col, 0.0))
        weather_scaled_vec = self.weather_scaler.transform(pd.DataFrame([weather_vals], columns=self.weather_cols))[0]

        def lookup_team_id(driver_id):
            team_id = self.team_by_session.get((session_key, driver_id))
            if team_id is None:
                team_id = self.team_by_year.get((year, driver_id))
            if team_id is None:
                team_id = self.driver_team_map.get(driver_id)
            return team_id

        def resolve_strategy(strat, rng):
            stops_map = {}
            starting_tyre = None
            for item in strat:
                if len(item) == 2:
                    lap, compound = item
                    lap = int(lap)
                    if lap == 0:
                        starting_tyre = compound
                    else:
                        stops_map[lap] = compound
                elif len(item) == 3:
                    start, end, compound = item
                    start = int(start)
                    end = int(end)
                    if start > end:
                        start, end = end, start
                    if start <= 0 <= end:
                        raise ValueError("Pit window cannot include lap 0; use (0, compound) for starting tyre")
                    window_laps = [lap for lap in range(start, end + 1) if lap > 0 and lap <= total_laps]
                    if not window_laps:
                        continue
                    lap = int(rng.integers(window_laps[0], window_laps[-1] + 1))
                    if lap in stops_map:
                        for candidate in window_laps:
                            if candidate not in stops_map:
                                lap = candidate
                                break
                    stops_map[lap] = compound
                else:
                    raise ValueError("Strategy entries must be (lap, compound) or (start, end, compound)")

            if starting_tyre is None:
                raise ValueError("Strategy must include lap 0 entry for starting tyre")
            return starting_tyre, stops_map

        grid_pos_map = {drv: idx + 1 for idx, drv in enumerate(grid_drivers)}

        drivers_state = []
        for idx, drv in enumerate(grid_drivers):
            strat = driver_strategies.get(drv, global_strategy)
            starting_tyre, stops_map = resolve_strategy(strat, pit_rng)
            drivers_state.append(
                {
                    "driver_id": drv,
                    "team_id": lookup_team_id(drv),
                    "driver_id_id": self._encode_value(drv, self.cat_vocabs["driver_id"]),
                    "team_id_id": self._encode_value(lookup_team_id(drv), self.cat_vocabs["team_id"]),
                    "driver_weight": float(self.driver_counts.get(drv, 0.0)) / (float(self.driver_counts.get(drv, 0.0)) + self.driver_shrink_k),
                    "grid_position": idx + 1,
                    "position": idx + 1,
                    "cumul_time": float(idx * 0.3),
                    "laps_on_current_tyre": 1,
                    "tyre_compound": starting_tyre,
                    "gap_to_ahead": 0.0,
                    "stops": stops_map,
                    "history": [],
                    "dnf": False,
                }
            )

        race_log = []
        pit_losses = []

        for lap in range(1, total_laps + 1):
            prev_positions = {s["driver_id"]: s["position"] for s in drivers_state}
            drivers_by_pos = sorted(
                [s for s in drivers_state if not s.get("dnf", False)],
                key=lambda s: s["position"],
            )

            for idx, s in enumerate(drivers_by_pos):
                if idx == 0:
                    s["gap_to_ahead"] = 0.0
                else:
                    ahead = drivers_by_pos[idx - 1]
                    s["gap_to_ahead"] = s["cumul_time"] - ahead["cumul_time"]

            n = len(drivers_by_pos)
            laps_on_tyre_for_update = []
            gap_ahead = np.zeros(n, dtype=float)
            drs = np.zeros(n, dtype=float)
            tyre_age = np.zeros(n, dtype=float)
            expected_len = np.zeros(n, dtype=float)
            compound_ids = np.zeros(n, dtype=int)
            driver_id_ids = np.zeros(n, dtype=int)
            team_id_ids = np.zeros(n, dtype=int)
            driver_weight = np.zeros(n, dtype=float)

            for idx, s in enumerate(drivers_by_pos):
                tyre_age_feature = s["laps_on_current_tyre"]
                laps_on_current_tyre_next = tyre_age_feature + 1
                gap_val = float(s["gap_to_ahead"])
                drs_enabled = 1 if (lap >= 3 and gap_val <= 1.0) else 0

                exp_len = expected_by_compound.get(s["tyre_compound"], self.expected_global)

                gap_ahead[idx] = gap_val
                drs[idx] = drs_enabled
                tyre_age[idx] = float(tyre_age_feature)
                expected_len[idx] = float(exp_len)
                compound_ids[idx] = compound_vocab.get(str(s["tyre_compound"]), compound_vocab["__UNK__"])
                driver_id_ids[idx] = s["driver_id_id"]
                team_id_ids[idx] = s["team_id_id"]
                driver_weight[idx] = s["driver_weight"]

                laps_on_tyre_for_update.append(laps_on_current_tyre_next)

            age_norm = tyre_age / np.maximum(expected_len, 1e-6)
            age_over = np.clip(tyre_age - expected_len, 0.0, None)
            age_over_norm = age_over / np.maximum(expected_len, 1e-6)

            lap_spline = np.tile(spline_by_lap[lap - 1], (n, 1))
            laps_remaining_norm = np.full(n, laps_remaining_norm_by_lap[lap - 1], dtype=float)
            weather_scaled = np.tile(weather_scaled_vec, (n, 1))
            circuit_id_ids = np.full(n, circuit_id_id, dtype=int)
            year_id_ids = np.full(n, year_id, dtype=int)
            session_id_ids = np.full(n, session_id, dtype=int)

            clean_pred, traffic_pred = self.predict_clean_and_traffic_fast(
                driver_id_ids,
                team_id_ids,
                circuit_id_ids,
                year_id_ids,
                session_id_ids,
                compound_ids,
                driver_weight,
                laps_remaining_norm,
                tyre_age,
                age_norm,
                age_over_norm,
                expected_len,
                lap_spline,
                weather_scaled,
                gap_ahead,
                drs,
            )
            clean_pred = np.asarray(clean_pred, dtype=float)
            traffic_pred = np.asarray(traffic_pred, dtype=float)
            base_lap = self.circuit_median_map.get(circuit_id, self.global_median_lap)
            lap_times = base_lap + clean_pred + traffic_pred

            safety_car_active = lap in safety_car_laps
            if safety_car_active:
                lap_times = np.asarray(lap_times, dtype=float)
                leader_time = lap_times[0] * 1.35
                sc_lap_times = [leader_time]
                for idx in range(1, len(drivers_by_pos)):
                    candidate = float(lap_times[idx])
                    start_gap = float(drivers_by_pos[idx]["gap_to_ahead"])
                    gap_end = start_gap + (candidate - sc_lap_times[idx - 1])
                    if gap_end < 0.0:
                        candidate = candidate + abs(gap_end) + 0.3
                    sc_lap_times.append(candidate)
                lap_times = np.array(sc_lap_times)
                pred_deltas = lap_times - base_lap
                overtake_attempts = np.zeros(len(drivers_by_pos), dtype=bool)
            else:
                if noise_by_driver:
                    lap_times = np.asarray(lap_times, dtype=float)
                    for idx, s in enumerate(drivers_by_pos):
                        noise_seq = noise_by_driver.get(s["driver_id"])
                        if noise_seq is not None and lap - 1 < len(noise_seq):
                            lap_times[idx] += float(noise_seq[lap - 1])
                lap_times, pred_deltas, overtake_attempts = self.apply_overtakes_for_lap(
                    circuit_id=circuit_id,
                    drivers_by_pos=drivers_by_pos,
                    lap_times=lap_times,
                    base_lap=base_lap,
                    year=year,
                    close_gap_threshold=1.0,
                    fail_gap=0.3,
                    rng=overtake_rng,
                )

            drivers_by_pos, dnfs_this_lap = self.apply_dnfs_for_lap(
                circuit_id=circuit_id,
                drivers_by_pos=drivers_by_pos,
                lap_number=lap,
                total_race_laps=total_laps,
                year=year,
                rng=dnf_rng,
            )

            attempts_this_lap = {
                drivers_by_pos[i]["driver_id"]: bool(overtake_attempts[i])
                for i in range(len(drivers_by_pos))
            }
            dnfs_map_this_lap = {
                drivers_by_pos[i]["driver_id"]: bool(dnfs_this_lap[i])
                for i in range(len(drivers_by_pos))
            }

            for idx, s in enumerate(drivers_by_pos):
                lap_time = float(lap_times[idx])
                delta = float(pred_deltas[idx])
                laps_on_current_tyre_next = int(laps_on_tyre_for_update[idx])

                compound_this_lap = s["tyre_compound"]
                pit_compound = s["stops"].get(lap)
                pitted = False
                pit_loss_this_lap = 0.0
                if pit_compound is not None:
                    if pit_loss is None:
                        pit_stats = self.pit_loss_map.get(circuit_id, {})
                        floor = pit_stats.get("pit_loss_floor")
                        excess_mean = pit_stats.get("pit_excess_mean")
                        excess_std = pit_stats.get("pit_excess_std")

                        if floor is None or excess_mean is None:
                            mean_loss = float(pit_stats.get("pit_loss_mean", self.pit_loss_mean_global))
                            std_loss = float(pit_stats.get("pit_loss_std", self.pit_loss_std_global) or 0.0)
                            if not np.isfinite(std_loss) or std_loss < 0:
                                std_loss = self.pit_loss_std_global
                            if not np.isfinite(mean_loss) or mean_loss <= 0:
                                mean_loss = self.pit_loss_mean_global
                            floor = max(0.0, mean_loss - std_loss)
                            excess_mean = max(0.0, mean_loss - floor)
                            excess_std = std_loss
                        else:
                            floor = float(floor)
                            excess_mean = float(excess_mean)
                            excess_std = float(excess_std or self.pit_loss_excess_std_global)

                        if not np.isfinite(floor) or floor < 0:
                            floor = self.pit_loss_floor_global
                        if not np.isfinite(excess_mean) or excess_mean < 0:
                            excess_mean = self.pit_loss_excess_mean_global
                        if not np.isfinite(excess_std) or excess_std < 0:
                            excess_std = self.pit_loss_excess_std_global

                        if excess_mean <= 0 or excess_std == 0.0:
                            sampled_excess = max(0.0, excess_mean)
                        else:
                            shape = (excess_mean / excess_std) ** 2
                            scale = (excess_std ** 2) / max(excess_mean, 1e-6)
                            if not np.isfinite(shape) or not np.isfinite(scale) or shape <= 0 or scale <= 0:
                                sampled_excess = max(0.0, excess_mean)
                            else:
                                sampled_excess = float(pit_rng.gamma(shape, scale))

                        sampled_loss = max(0.0, floor + sampled_excess)
                    else:
                        sampled_loss = float(pit_loss)
                    if safety_car_active:
                        sampled_loss *= 0.75
                    lap_time += sampled_loss
                    pit_losses.append(sampled_loss)
                    pit_loss_this_lap = sampled_loss
                    pitted = True

                dnf_now = dnfs_map_this_lap.get(s["driver_id"], False)
                s["dnf"] = bool(s.get("dnf", False) or dnf_now)

                if not s["dnf"]:
                    s["laps_on_current_tyre"] = laps_on_current_tyre_next
                    s["cumul_time"] += lap_time

                s["history"].append(
                    {
                        "lap": lap,
                        "lap_time": lap_time if not dnf_now else None,
                        "delta": delta if not dnf_now else None,
                        "tyre_compound": compound_this_lap,
                        "pitted": pitted,
                        "pit_loss": pit_loss_this_lap,
                        "overtake_attempt": attempts_this_lap.get(s["driver_id"], False),
                        "dnf": dnf_now,
                    }
                )

                if s["dnf"]:
                    continue
                if pit_compound is not None:
                    s["tyre_compound"] = pit_compound
                    s["laps_on_current_tyre"] = 1

            drivers_state = sorted(
                drivers_state,
                key=lambda s: (s.get("dnf", False), s["cumul_time"], s["grid_position"]),
            )
            for pos, s in enumerate(drivers_state, start=1):
                s["position"] = pos

            leader_time = drivers_state[0]["cumul_time"]
            for s in drivers_state:
                last_lap = s["history"][-1]
                gap_to_leader = s["cumul_time"] - leader_time
                pitted = last_lap["pitted"]
                attempted = last_lap["overtake_attempt"]
                dnf_now = last_lap.get("dnf", False)
                lap_time = last_lap["lap_time"]
                delta = last_lap["delta"]

                race_log.append(
                    {
                        "lap": lap,
                        "position": s["position"],
                        "driver_id": s["driver_id"],
                        "lap_time": lap_time,
                        "delta": delta,
                        "tyre_compound": last_lap["tyre_compound"],
                        "pitted": pitted,
                        "pit_loss": last_lap["pit_loss"],
                        "gap_to_leader": gap_to_leader,
                        "cumul_time": s["cumul_time"],
                        "overtake_attempt": attempted,
                        "dnf": dnf_now or s.get("dnf", False),
                        "pos_change_lap": prev_positions[s["driver_id"]] - s["position"],
                        "pos_change_total": grid_pos_map[s["driver_id"]] - s["position"],
                        "safety_car": safety_car_active,
                    }
                )

        pit_loss_avg = float(np.mean(pit_losses)) if pit_losses else 0.0
        return pd.DataFrame(race_log), safety_car_laps, pit_loss_avg

    def run_strategy_comparison(
        self,
        strategy_a_global,
        strategy_b_global,
        strategy_a_driver,
        strategy_b_driver,
        num_runs_compare=2000,
        race_length=60,
        update_every=20,
        circuit_id=None,
        year=None,
        grid=None,
        safety_car_laps=None,
        rain_laps=None,
        from_notebook=True,
        progress_callback=None,
    ):
        summary_comp = []

        if from_notebook:
            try:
                from IPython.display import display, clear_output
            except Exception:
                from_notebook = False

        lap_sum = {"A": np.zeros(race_length), "B": np.zeros(race_length)}
        lap_count = {"A": np.zeros(race_length), "B": np.zeros(race_length)}

        driver_lap_sum = {"A": {}, "B": {}}
        driver_lap_count = {"A": {}, "B": {}}

        driver_pos_sum = {"A": {}, "B": {}}
        driver_pos_count = {"A": {}, "B": {}}

        def driver_avg_lap(label, drv):
            total = driver_lap_sum[label].get(drv, 0.0)
            count = driver_lap_count[label].get(drv, 0.0)
            return total / count if count else np.nan

        custom_drivers = {
            "A": list(strategy_a_driver.keys()),
            "B": list(strategy_b_driver.keys()),
        }

        all_custom_drivers = sorted(set(custom_drivers.get("A", []) + custom_drivers.get("B", [])))

        custom_sum = {
            label: {drv: np.zeros(race_length) for drv in all_custom_drivers}
            for label in ["A", "B"]
        }
        custom_count = {
            label: {drv: np.zeros(race_length) for drv in all_custom_drivers}
            for label in ["A", "B"]
        }

        run_iter = range(num_runs_compare)
        if from_notebook:
            run_iter = tqdm(run_iter, desc="Strategy comparison")

        for run in run_iter:
            run_rng = np.random.default_rng(self.master_rng.integers(0, 1_000_000_000))
            chosen_circuit = circuit_id if circuit_id is not None else run_rng.choice(self.circuits)
            chosen_year = int(year) if year is not None else int(run_rng.choice(self.years_by_circuit.get(chosen_circuit, [2025])))
            chosen_grid = grid if grid is not None else self.grid_drivers

            configs = [
                ("A", strategy_a_global, strategy_a_driver),
                ("B", strategy_b_global, strategy_b_driver),
            ]

            base_seed = run_rng.integers(0, 1_000_000_000)
            for label, glob_strat, driver_strats in configs:
                rng_run = np.random.default_rng(base_seed)
                race_log, sc_laps, pit_loss_avg = self.simulate_race(
                    circuit_id=chosen_circuit,
                    grid_drivers=chosen_grid,
                    total_laps=race_length,
                    year=chosen_year,
                    global_strategy=glob_strat,
                    driver_strategies=driver_strats,
                    safety_car_laps=safety_car_laps,
                    rain_laps=rain_laps,
                    pit_loss=None,
                    rng=rng_run,
                )
                last_lap = race_log["lap"].max()
                final_class = race_log[race_log["lap"] == last_lap].sort_values("position")
                pit_by_driver = (
                    race_log[race_log["pit_loss"] > 0]
                    .groupby("driver_id")["pit_loss"]
                    .agg(["sum", "count"])
                    .to_dict("index")
                )
                for _, row in final_class.iterrows():
                    summary_comp.append({
                        "run": run,
                        "strategy": label,
                        "circuit_id": chosen_circuit,
                        "year": chosen_year,
                        "driver_id": row["driver_id"],
                        "finish_pos": row["position"],
                        "dnf": bool(row["dnf"]),
                        "sc_laps": len(sc_laps),
                        "pit_loss_avg": pit_loss_avg,
                        "pit_loss_sum": pit_by_driver.get(row["driver_id"], {}).get("sum", 0.0),
                        "pit_loss_count": pit_by_driver.get(row["driver_id"], {}).get("count", 0.0),
                    })

                lap_stats = (
                    race_log
                    .dropna(subset=["lap_time"])
                    .groupby("lap")["lap_time"]
                    .agg(["sum", "count"])
                    .reindex(range(1, race_length + 1), fill_value=0.0)
                )
                lap_sum[label] += lap_stats["sum"].to_numpy()
                lap_count[label] += lap_stats["count"].to_numpy()

                driver_stats = (
                    race_log
                    .dropna(subset=["lap_time"])
                    .groupby("driver_id")["lap_time"]
                    .agg(["sum", "count"])
                )
                for drv, row in driver_stats.iterrows():
                    driver_lap_sum[label][drv] = driver_lap_sum[label].get(drv, 0.0) + float(row["sum"])
                    driver_lap_count[label][drv] = driver_lap_count[label].get(drv, 0.0) + float(row["count"])

                driver_pos_stats = (
                    race_log
                    .dropna(subset=["position"])
                    .groupby(["driver_id", "lap"])["position"]
                    .mean()
                    .unstack(fill_value=np.nan)
                    .reindex(columns=range(1, race_length + 1))
                )
                for drv in driver_pos_stats.index:
                    pos_vals = driver_pos_stats.loc[drv].to_numpy(dtype=float)
                    pos_sum = driver_pos_sum[label].get(drv)
                    pos_cnt = driver_pos_count[label].get(drv)
                    if pos_sum is None:
                        pos_sum = np.zeros(race_length)
                        pos_cnt = np.zeros(race_length)
                    mask = ~np.isnan(pos_vals)
                    pos_sum[mask] += pos_vals[mask]
                    pos_cnt[mask] += 1
                    driver_pos_sum[label][drv] = pos_sum
                    driver_pos_count[label][drv] = pos_cnt

                for drv in all_custom_drivers:
                    drv_stats = (
                        race_log[race_log["driver_id"] == drv]
                        .dropna(subset=["lap_time"])
                        .groupby("lap")["lap_time"]
                        .agg(["sum", "count"])
                        .reindex(range(1, race_length + 1), fill_value=0.0)
                    )
                    custom_sum[label][drv] += drv_stats["sum"].to_numpy()
                    custom_count[label][drv] += drv_stats["count"].to_numpy()

            if (run + 1) % update_every == 0 or run == num_runs_compare - 1:
                summary_comp_df = pd.DataFrame(summary_comp)
                wins = summary_comp_df[summary_comp_df["finish_pos"] == 1].groupby("strategy")["driver_id"].count()
                avg_finish = summary_comp_df.groupby(["driver_id", "strategy"])["finish_pos"].mean().unstack()
                avg_finish["delta_B_minus_A"] = avg_finish.get("B", np.nan) - avg_finish.get("A", np.nan)
                avg_finish["avg_lap_time_A"] = [driver_avg_lap("A", drv) for drv in avg_finish.index]
                avg_finish["avg_lap_time_B"] = [driver_avg_lap("B", drv) for drv in avg_finish.index]
                dnf_counts = summary_comp_df.groupby(["driver_id", "strategy"])["dnf"].sum().unstack()
                avg_finish["dnf_A"] = dnf_counts.get("A")
                avg_finish["dnf_B"] = dnf_counts.get("B")
                wins_by = (
                    summary_comp_df[summary_comp_df["finish_pos"] == 1]
                    .groupby(["driver_id", "strategy"])["finish_pos"]
                    .count()
                    .unstack()
                )
                wins_a = wins_by.get("A") if wins_by is not None else None
                wins_b = wins_by.get("B") if wins_by is not None else None
                avg_finish["wins_A"] = wins_a.reindex(avg_finish.index).fillna(0) if wins_a is not None else 0.0
                avg_finish["wins_B"] = wins_b.reindex(avg_finish.index).fillna(0) if wins_b is not None else 0.0
                podiums_by = (
                    summary_comp_df[summary_comp_df["finish_pos"] <= 3]
                    .groupby(["driver_id", "strategy"])["finish_pos"]
                    .count()
                    .unstack()
                )
                podiums_a = podiums_by.get("A") if podiums_by is not None else None
                podiums_b = podiums_by.get("B") if podiums_by is not None else None
                avg_finish["podiums_A"] = podiums_a.reindex(avg_finish.index).fillna(0) if podiums_a is not None else 0.0
                avg_finish["podiums_B"] = podiums_b.reindex(avg_finish.index).fillna(0) if podiums_b is not None else 0.0
                sc_by_run = summary_comp_df[["run", "strategy", "sc_laps"]].drop_duplicates()
                runs_a = sc_by_run[sc_by_run["strategy"] == "A"]["run"].nunique()
                runs_b = sc_by_run[sc_by_run["strategy"] == "B"]["run"].nunique()
                sc_pct_a = (sc_by_run[sc_by_run["strategy"] == "A"]["sc_laps"].sum() * 100.0 / max(runs_a * race_length, 1))
                sc_pct_b = (sc_by_run[sc_by_run["strategy"] == "B"]["sc_laps"].sum() * 100.0 / max(runs_b * race_length, 1))
                avg_finish["sc_laps_A"] = sc_pct_a
                avg_finish["sc_laps_B"] = sc_pct_b
                pit_sum = summary_comp_df.groupby(["driver_id", "strategy"])["pit_loss_sum"].sum().unstack()
                pit_count = summary_comp_df.groupby(["driver_id", "strategy"])["pit_loss_count"].sum().unstack()
                avg_finish["pit_loss_A"] = pit_sum.get("A") / pit_count.get("A")
                avg_finish["pit_loss_B"] = pit_sum.get("B") / pit_count.get("B")

                if from_notebook:
                    clear_output(wait=True)
                    print(f"Progress: {run + 1}/{num_runs_compare}")
                    print("Wins per strategy:", wins)
                    print("Average finish per driver (A vs B, lower is better):")
                    display(avg_finish.sort_values("delta_B_minus_A"))

                    laps_axis = np.arange(1, race_length + 1)
                    fig, ax = plt.subplots(figsize=(10, 4))
                    for label, color in [("A", "#1f77b4"), ("B", "#ff7f0e")]:
                        avg_lap = lap_sum[label] / np.maximum(lap_count[label], 1)
                        ax.plot(laps_axis, avg_lap, label=f"Strategy {label}", color=color)
                    ax.set_xlabel("Lap")
                    ax.set_ylabel("Avg lap time (s)")
                    ax.set_title("Average lap time per lap (all drivers, running avg)")
                    ax.legend()
                    plt.show()

                    all_custom_drivers = sorted(set(custom_drivers.get("A", []) + custom_drivers.get("B", [])))
                    for drv in all_custom_drivers:
                        fig, ax = plt.subplots(figsize=(10, 4))
                        plotted = False
                        for label, color in [("A", "#1f77b4"), ("B", "#ff7f0e")]:
                            avg_driver = custom_sum[label].get(drv, np.zeros(race_length)) / np.maximum(custom_count[label].get(drv, np.zeros(race_length)), 1)
                            if np.any(custom_count[label].get(drv, np.zeros(race_length))):
                                ax.plot(laps_axis, avg_driver, label=f"{drv} Strategy {label}", color=color)
                            else:
                                ax.plot(laps_axis, avg_driver, label=f"{drv} Strategy {label}", color=color, alpha=0.25)
                            plotted = True
                        if plotted:
                            ax.set_xlabel("Lap")
                            ax.set_ylabel("Avg lap time (s)")
                            ax.set_title(f"Average lap time per lap for {drv} (running avg)")
                            ax.legend()
                            plt.show()

                    for drv in all_custom_drivers:
                        fig, ax = plt.subplots(figsize=(10, 4))
                        plotted = False
                        for label, color in [("A", "#1f77b4"), ("B", "#ff7f0e")]:
                            pos_sum = driver_pos_sum.get(label, {}).get(drv, np.zeros(race_length))
                            pos_cnt = driver_pos_count.get(label, {}).get(drv, np.zeros(race_length))
                            avg_pos = pos_sum / np.maximum(pos_cnt, 1)
                            if np.any(pos_cnt):
                                ax.plot(laps_axis, avg_pos, label=f"{drv} Strategy {label}", color=color)
                            else:
                                ax.plot(laps_axis, avg_pos, label=f"{drv} Strategy {label}", color=color, alpha=0.25)
                            plotted = True
                        if plotted:
                            ax.set_xlabel("Lap")
                            ax.set_ylabel("Avg position")
                            ax.set_title(f"Average position per lap for {drv} (running avg)")
                            ax.invert_yaxis()
                            ax.legend()
                            plt.show()

                if progress_callback is not None:
                    wins_dict = wins.to_dict() if wins is not None else {}
                    progress_callback({
                        "event": "progress",
                        "run": run + 1,
                        "total_runs": num_runs_compare,
                        "wins": {k: int(v) for k, v in wins_dict.items()},
                    })

        summary_comp_df = pd.DataFrame(summary_comp)

        wins = summary_comp_df[summary_comp_df["finish_pos"] == 1].groupby("strategy")["driver_id"].count()
        avg_finish = summary_comp_df.groupby(["driver_id", "strategy"])['finish_pos'].mean().unstack()
        avg_finish["delta_B_minus_A"] = avg_finish.get("B", np.nan) - avg_finish.get("A", np.nan)
        avg_finish["avg_lap_time_A"] = [driver_avg_lap("A", drv) for drv in avg_finish.index]
        avg_finish["avg_lap_time_B"] = [driver_avg_lap("B", drv) for drv in avg_finish.index]
        dnf_counts = summary_comp_df.groupby(["driver_id", "strategy"])['dnf'].sum().unstack()
        avg_finish["dnf_A"] = dnf_counts.get("A")
        avg_finish["dnf_B"] = dnf_counts.get("B")
        wins_by = (
            summary_comp_df[summary_comp_df["finish_pos"] == 1]
            .groupby(["driver_id", "strategy"])['finish_pos']
            .count()
            .unstack()
        )
        wins_a = wins_by.get("A") if wins_by is not None else None
        wins_b = wins_by.get("B") if wins_by is not None else None
        avg_finish["wins_A"] = wins_a.reindex(avg_finish.index).fillna(0) if wins_a is not None else 0.0
        avg_finish["wins_B"] = wins_b.reindex(avg_finish.index).fillna(0) if wins_b is not None else 0.0
        podiums_by = (
            summary_comp_df[summary_comp_df["finish_pos"] <= 3]
            .groupby(["driver_id", "strategy"])['finish_pos']
            .count()
            .unstack()
        )
        podiums_a = podiums_by.get("A") if podiums_by is not None else None
        podiums_b = podiums_by.get("B") if podiums_by is not None else None
        avg_finish["podiums_A"] = podiums_a.reindex(avg_finish.index).fillna(0) if podiums_a is not None else 0.0
        avg_finish["podiums_B"] = podiums_b.reindex(avg_finish.index).fillna(0) if podiums_b is not None else 0.0
        sc_by_run = summary_comp_df[["run", "strategy", "sc_laps"]].drop_duplicates()
        runs_a = sc_by_run[sc_by_run["strategy"] == "A"]["run"].nunique()
        runs_b = sc_by_run[sc_by_run["strategy"] == "B"]["run"].nunique()
        sc_pct_a = (sc_by_run[sc_by_run["strategy"] == "A"]["sc_laps"].sum() * 100.0 / max(runs_a * race_length, 1))
        sc_pct_b = (sc_by_run[sc_by_run["strategy"] == "B"]["sc_laps"].sum() * 100.0 / max(runs_b * race_length, 1))
        avg_finish["sc_laps_A"] = sc_pct_a
        avg_finish["sc_laps_B"] = sc_pct_b

        pit_sum = summary_comp_df.groupby(["driver_id", "strategy"])['pit_loss_sum'].sum().unstack()
        pit_count = summary_comp_df.groupby(["driver_id", "strategy"])['pit_loss_count'].sum().unstack()
        avg_finish["pit_loss_A"] = pit_sum.get("A") / pit_count.get("A")
        avg_finish["pit_loss_B"] = pit_sum.get("B") / pit_count.get("B")

        if from_notebook:
            print("Wins per strategy:", wins)
            print("Average finish per driver (A vs B, lower is better): ", avg_finish.sort_values("delta_B_minus_A"))

            laps_axis = np.arange(1, race_length + 1)
            fig, ax = plt.subplots(figsize=(10, 4))
            for label, color in [("A", "#1f77b4"), ("B", "#ff7f0e")]:
                avg_lap = lap_sum[label] / np.maximum(lap_count[label], 1)
                ax.plot(laps_axis, avg_lap, label=f"Strategy {label}", color=color)
            ax.set_xlabel("Lap")
            ax.set_ylabel("Avg lap time (s)")
            ax.set_title("Average lap time per lap (all drivers, all runs)")
            ax.legend()
            plt.show()

            for label in ["A", "B"]:
                for drv in custom_drivers.get(label, []):
                    avg_driver = custom_sum[label][drv] / np.maximum(custom_count[label][drv], 1)
                    fig, ax = plt.subplots(figsize=(10, 4))
                    ax.plot(laps_axis, avg_driver, label=f"{drv} Strategy {label}")
                    ax.set_xlabel("Lap")
                    ax.set_ylabel("Avg lap time (s)")
                    ax.set_title(f"Average lap time per lap for {drv} (Strategy {label})")
                    ax.legend()
                    plt.show()

        return summary_comp_df, avg_finish



__all__ = ["MonteCarloSimulator"]


def _df_to_records(frame):
    return json.loads(frame.to_json(orient="records"))


def _run_strategy_cli(args):
    with open(args.input, "r", encoding="utf-8") as f:
        payload = json.load(f)

    if "strategy" not in payload:
        raise ValueError("Missing required 'strategy' object in input JSON.")

    paths = payload.get("paths", {})
    options = payload.get("options", {})
    strategy = payload["strategy"]

    sim = MonteCarloSimulator(
        base_dir=paths.get("base_dir"),
        bundle_path=paths.get("bundle_path"),
        data_path=paths.get("data_path"),
        overtake_path=paths.get("overtake_path"),
        dnf_path=paths.get("dnf_path"),
        safety_path=paths.get("safety_path"),
        noise_scale=options.get("noise_scale", 0.5),
        verbose=False,
    )

    seed = options.get("seed")
    if seed is not None:
        sim.master_rng = np.random.default_rng(int(seed))

    def progress_callback(event):
        if options.get("stream_progress", False):
            print(json.dumps(event), flush=True)

    if options.get("stream_progress", False):
        progress_callback({
            "event": "start",
            "mode": "strategy_comparison",
            "total_runs": int(strategy.get("num_runs_compare", 0) or 0),
        })

    started_at = datetime.now(timezone.utc).isoformat()
    summary_comp_df, avg_finish = sim.run_strategy_comparison(
        strategy_a_global=strategy["strategy_a_global"],
        strategy_b_global=strategy["strategy_b_global"],
        strategy_a_driver=strategy.get("strategy_a_driver", {}),
        strategy_b_driver=strategy.get("strategy_b_driver", {}),
        num_runs_compare=int(strategy.get("num_runs_compare", 2000)),
        race_length=int(strategy.get("race_length", 60)),
        update_every=int(strategy.get("update_every", 20)),
        circuit_id=strategy.get("circuit_id"),
        year=strategy.get("year"),
        grid=strategy.get("grid"),
        safety_car_laps=strategy.get("safety_car_laps"),
        rain_laps=strategy.get("rain_laps"),
        from_notebook=False,
        progress_callback=progress_callback if options.get("stream_progress", False) else None,
    )
    finished_at = datetime.now(timezone.utc).isoformat()

    avg_finish_out = avg_finish.reset_index()
    output = {
        "meta": {
            "mode": "strategy_comparison",
            "seed": seed,
            "noise_scale": options.get("noise_scale", 0.5),
            "started_at": started_at,
            "finished_at": finished_at,
        },
        "strategy_comparison": {
            "summary_comp_df": _df_to_records(summary_comp_df),
            "avg_finish": _df_to_records(avg_finish_out),
        },
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    if options.get("stream_progress", False):
        progress_callback({
            "event": "done",
            "output": str(output_path),
        })


def _build_parser():
    parser = argparse.ArgumentParser(description="Monte Carlo strategy comparison CLI")
    parser.add_argument("--strategy", action="store_true", help="Run strategy comparison mode.")
    parser.add_argument("--input", required=True, help="Path to input JSON file.")
    parser.add_argument("--output", required=True, help="Path to output JSON file.")
    return parser


def main(argv=None):
    parser = _build_parser()
    args = parser.parse_args(argv)
    if not args.strategy:
        parser.error("--strategy is required for this CLI.")
    _run_strategy_cli(args)


if __name__ == "__main__":
    main()
