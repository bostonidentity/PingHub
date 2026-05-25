export interface RefreshIntervalOption {
    value: number; // seconds
    label: string;
}

/** Shared auto-refresh interval choices used by Monitor pages. */
export const REFRESH_INTERVAL_OPTIONS: RefreshIntervalOption[] = [
    { value: 15, label: "15s" },
    { value: 30, label: "30s" },
    { value: 60, label: "1m" },
    { value: 5 * 60, label: "5m" },
    { value: 15 * 60, label: "15m" },
    { value: 30 * 60, label: "30m" },
    { value: 60 * 60, label: "1h" },
    { value: 2 * 60 * 60, label: "2h" },
    { value: 6 * 60 * 60, label: "6h" },
    { value: 12 * 60 * 60, label: "12h" },
    { value: 24 * 60 * 60, label: "1d" },
    { value: 2 * 24 * 60 * 60, label: "2d" },
    { value: 7 * 24 * 60 * 60, label: "7d" },
];
