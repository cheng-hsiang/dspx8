// Factory values read from the real DSP-X8s (register dump 2026-09-30). Hand-maintained: tables.js is generated.

/** Centre frequency of each of the 31 bands in the mode region (slot 32 is parked at 20 kHz). */
export const DEVICE_EQ_F = [20.1, 25.3, 32.5, 40.1, 50.6, 63.7, 80.3, 101, 125, 161, 202, 250, 315, 405, 500, 630, 809, 1000, 1260, 1620,
  2000, 2520, 3170, 4000, 5040, 6350, 8000, 10100, 12500, 16000, 20200];

/** Frequencies of the OEM app's 10-band layer (1252..1571). */
export const DEVICE_APP_F = [60, 350, 2000, 10100, 250, 809, 3170, 6350, 8000, 20000];
