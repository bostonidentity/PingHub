export interface SearchMatch {
  line: number;
  text: string;
  submatches: { start: number; end: number }[];
}

export interface SearchFileResult {
  path: string;
  scope: string;
  matches: SearchMatch[];
}

export interface SearchResponse {
  results: SearchFileResult[];
  totalFiles: number;
  totalMatches: number;
  truncated: boolean;
  error?: string;
}
