export interface DriverInfo {
  firstName: string;
  lastName: string;
  nationality: string;
}

interface DriverNumberAssignment extends DriverInfo {
  number: number;
  startYear: number;
  endYear: number | null;
}

// Derived from the provided Wikipedia driver number table (seasons 2014-2025)
const DRIVER_NUMBER_HISTORY: DriverNumberAssignment[] = [
  { number: 1, firstName: 'Sebastian', lastName: 'Vettel', nationality: 'German', startYear: 2014, endYear: 2014 },
  { number: 1, firstName: 'Max', lastName: 'Verstappen', nationality: 'Dutch', startYear: 2022, endYear: null },
  { number: 2, firstName: 'Stoffel', lastName: 'Vandoorne', nationality: 'Belgian', startYear: 2017, endYear: 2018 },
  { number: 2, firstName: 'Logan', lastName: 'Sargeant', nationality: 'American', startYear: 2023, endYear: 2024 },
  { number: 3, firstName: 'Daniel', lastName: 'Ricciardo', nationality: 'Australian', startYear: 2014, endYear: 2024 },
  { number: 4, firstName: 'Max', lastName: 'Chilton', nationality: 'British', startYear: 2014, endYear: 2014 },
  { number: 4, firstName: 'Lando', lastName: 'Norris', nationality: 'British', startYear: 2019, endYear: null },
  { number: 5, firstName: 'Sebastian', lastName: 'Vettel', nationality: 'German', startYear: 2015, endYear: 2022 },
  { number: 5, firstName: 'Gabriel', lastName: 'Bortoleto', nationality: 'Brazilian', startYear: 2025, endYear: null },
  { number: 6, firstName: 'Nico', lastName: 'Rosberg', nationality: 'German', startYear: 2014, endYear: 2016 },
  { number: 6, firstName: 'Nicholas', lastName: 'Latifi', nationality: 'Canadian', startYear: 2020, endYear: 2022 },
  { number: 6, firstName: 'Isack', lastName: 'Hadjar', nationality: 'French', startYear: 2025, endYear: null },
  { number: 7, firstName: 'Kimi', lastName: 'Raikkonen', nationality: 'Finnish', startYear: 2014, endYear: 2021 },
  { number: 7, firstName: 'Jack', lastName: 'Doohan', nationality: 'Australian', startYear: 2025, endYear: 2025 },
  { number: 8, firstName: 'Romain', lastName: 'Grosjean', nationality: 'French', startYear: 2014, endYear: 2020 },
  { number: 9, firstName: 'Marcus', lastName: 'Ericsson', nationality: 'Swedish', startYear: 2014, endYear: 2018 },
  { number: 9, firstName: 'Nikita', lastName: 'Mazepin', nationality: 'Russian', startYear: 2021, endYear: 2021 },
  { number: 10, firstName: 'Kamui', lastName: 'Kobayashi', nationality: 'Japanese', startYear: 2014, endYear: 2014 },
  { number: 10, firstName: 'Pierre', lastName: 'Gasly', nationality: 'French', startYear: 2017, endYear: null },
  { number: 11, firstName: 'Sergio', lastName: 'Perez', nationality: 'Mexican', startYear: 2014, endYear: 2024 },
  { number: 12, firstName: 'Felipe', lastName: 'Nasr', nationality: 'Brazilian', startYear: 2015, endYear: 2016 },
  { number: 12, firstName: 'Andrea Kimi', lastName: 'Antonelli', nationality: 'Italian', startYear: 2025, endYear: null },
  { number: 13, firstName: 'Pastor', lastName: 'Maldonado', nationality: 'Venezuelan', startYear: 2014, endYear: 2015 },
  { number: 14, firstName: 'Fernando', lastName: 'Alonso', nationality: 'Spanish', startYear: 2014, endYear: null },
  { number: 16, firstName: 'Charles', lastName: 'Leclerc', nationality: 'Monegasque', startYear: 2018, endYear: null },
  { number: 17, firstName: 'Jules', lastName: 'Bianchi', nationality: 'French', startYear: 2014, endYear: 2014 },
  { number: 18, firstName: 'Lance', lastName: 'Stroll', nationality: 'Canadian', startYear: 2017, endYear: null },
  { number: 19, firstName: 'Felipe', lastName: 'Massa', nationality: 'Brazilian', startYear: 2014, endYear: 2017 },
  { number: 20, firstName: 'Kevin', lastName: 'Magnussen', nationality: 'Danish', startYear: 2014, endYear: 2024 },
  { number: 21, firstName: 'Esteban', lastName: 'Gutierrez', nationality: 'Mexican', startYear: 2014, endYear: 2016 },
  { number: 21, firstName: 'Nyck', lastName: 'de Vries', nationality: 'Dutch', startYear: 2023, endYear: 2023 },
  { number: 22, firstName: 'Jenson', lastName: 'Button', nationality: 'British', startYear: 2014, endYear: 2017 },
  { number: 22, firstName: 'Yuki', lastName: 'Tsunoda', nationality: 'Japanese', startYear: 2021, endYear: null },
  { number: 23, firstName: 'Alexander', lastName: 'Albon', nationality: 'Thai', startYear: 2019, endYear: null },
  { number: 24, firstName: 'Zhou', lastName: 'Guanyu', nationality: 'Chinese', startYear: 2022, endYear: 2024 },
  { number: 25, firstName: 'Jean-Eric', lastName: 'Vergne', nationality: 'French', startYear: 2014, endYear: 2014 },
  { number: 26, firstName: 'Daniil', lastName: 'Kvyat', nationality: 'Russian', startYear: 2014, endYear: 2020 },
  { number: 27, firstName: 'Nico', lastName: 'Hulkenberg', nationality: 'German', startYear: 2014, endYear: null },
  { number: 28, firstName: 'Will', lastName: 'Stevens', nationality: 'British', startYear: 2015, endYear: 2015 },
  { number: 28, firstName: 'Brendon', lastName: 'Hartley', nationality: 'New Zealander', startYear: 2017, endYear: 2018 },
  { number: 30, firstName: 'Jolyon', lastName: 'Palmer', nationality: 'British', startYear: 2016, endYear: 2017 },
  { number: 30, firstName: 'Liam', lastName: 'Lawson', nationality: 'New Zealander', startYear: 2024, endYear: null },
  { number: 31, firstName: 'Esteban', lastName: 'Ocon', nationality: 'French', startYear: 2016, endYear: null },
  { number: 33, firstName: 'Max', lastName: 'Verstappen', nationality: 'Dutch', startYear: 2015, endYear: null },
  { number: 35, firstName: 'Sergey', lastName: 'Sirotkin', nationality: 'Russian', startYear: 2018, endYear: 2018 },
  { number: 43, firstName: 'Franco', lastName: 'Colapinto', nationality: 'Argentine', startYear: 2024, endYear: null },
  { number: 44, firstName: 'Lewis', lastName: 'Hamilton', nationality: 'British', startYear: 2014, endYear: null },
  { number: 47, firstName: 'Mick', lastName: 'Schumacher', nationality: 'German', startYear: 2021, endYear: 2022 },
  { number: 53, firstName: 'Alexander', lastName: 'Rossi', nationality: 'American', startYear: 2015, endYear: 2015 },
  { number: 55, firstName: 'Carlos', lastName: 'Sainz Jr.', nationality: 'Spanish', startYear: 2015, endYear: null },
  { number: 63, firstName: 'George', lastName: 'Russell', nationality: 'British', startYear: 2019, endYear: null },
  { number: 77, firstName: 'Valtteri', lastName: 'Bottas', nationality: 'Finnish', startYear: 2014, endYear: 2024 },
  { number: 81, firstName: 'Oscar', lastName: 'Piastri', nationality: 'Australian', startYear: 2023, endYear: null },
  { number: 87, firstName: 'Oliver', lastName: 'Bearman', nationality: 'British', startYear: 2025, endYear: null },
  { number: 88, firstName: 'Rio', lastName: 'Haryanto', nationality: 'Indonesian', startYear: 2016, endYear: 2016 },
  { number: 88, firstName: 'Robert', lastName: 'Kubica', nationality: 'Polish', startYear: 2019, endYear: 2021 },
  { number: 89, firstName: 'Jack', lastName: 'Aitken', nationality: 'British', startYear: 2020, endYear: 2020 },
  { number: 94, firstName: 'Pascal', lastName: 'Wehrlein', nationality: 'German', startYear: 2016, endYear: 2017 },
  { number: 98, firstName: 'Roberto', lastName: 'Merhi', nationality: 'Spanish', startYear: 2015, endYear: 2015 },
  { number: 99, firstName: 'Adrian', lastName: 'Sutil', nationality: 'German', startYear: 2014, endYear: 2014 },
  { number: 99, firstName: 'Antonio', lastName: 'Giovinazzi', nationality: 'Italian', startYear: 2019, endYear: 2021 }
];

function toYear(dateInput: Date | string) {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }
  return date.getUTCFullYear();
}

export function getDriverByNumberOnDate(driverNumber: number, date: Date | string): DriverInfo | null {
  if (!Number.isFinite(driverNumber)) {
    return null;
  }

  const year = toYear(date);
  if (year == null) {
    return null;
  }

  const match = DRIVER_NUMBER_HISTORY.find(
    (entry) =>
      entry.number === driverNumber &&
      year >= entry.startYear &&
      (entry.endYear == null || year <= entry.endYear)
  );

  if (!match) {
    return null;
  }

  const { firstName, lastName, nationality } = match;
  return { firstName, lastName, nationality };
}

export function getDriverByNumber(driverNumber: number): DriverInfo | null {
  return getDriverByNumberOnDate(driverNumber, new Date());
}

export function getDriverHistory() {
  return DRIVER_NUMBER_HISTORY.slice();
}
