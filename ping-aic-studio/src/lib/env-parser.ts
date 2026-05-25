/**
 * Parse a .env file string into a key→value map.
 * Handles:
 *   - Single-quoted multiline values: KEY='{\n  ...\n}'
 *   - Double-quoted multiline values: KEY="line1\nline2"
 *   - Unquoted values (including \n-escaped legacy format)
 *   - Comment lines (#)
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    i++;

    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const rest = trimmed.slice(eqIdx + 1); // preserve leading whitespace/quotes

    const restTrimmed = rest.trim();

    if (restTrimmed.startsWith("'") || restTrimmed.startsWith('"')) {
      const quote = restTrimmed[0];
      const afterOpen = restTrimmed.slice(1);

      if (afterOpen.endsWith(quote)) {
        // Single-line quoted value
        result[key] = afterOpen.slice(0, -1);
      } else {
        // Multiline quoted value — accumulate until closing quote on its own
        let accumulated = afterOpen;
        while (i < lines.length) {
          const nextLine = lines[i];
          i++;
          if (nextLine.trimEnd().endsWith(quote)) {
            accumulated += "\n" + nextLine.trimEnd().slice(0, -1);
            break;
          }
          accumulated += "\n" + nextLine;
        }
        result[key] = accumulated;
      }
    } else {
      // Unquoted value — unescape \n for backward compatibility
      result[key] = restTrimmed.replace(/\\n/g, "\n");
    }
  }

  return result;
}

/**
 * Serialize known fields back to .env format compatible with dotenv.
 * - Multiline values (e.g. PEM/JWK keys) are single-quoted
 * - All other values are written as-is (unquoted)
 * - Comments and unknown keys from the original file are preserved
 */
export function serializeEnvFile(
  fields: Record<string, string>,
  originalContent: string
): string {
  const writtenKeys = new Set(Object.keys(fields));

  // Collect comments and unknown keys from the original, skipping
  // continuation lines that belong to multiline quoted values
  const extraLines: string[] = [];
  const seenKeys = new Set<string>();
  let insideMultiline = false;
  let multilineQuote = "";

  for (const line of originalContent.split("\n")) {
    const trimmed = line.trim();

    if (insideMultiline) {
      if (trimmed.endsWith(multilineQuote)) insideMultiline = false;
      continue; // skip continuation lines of known multiline values
    }

    if (!trimmed) continue;

    if (trimmed.startsWith("#")) {
      extraLines.push(line);
      continue;
    }

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const restTrimmed = trimmed.slice(eqIdx + 1).trim();

    // Detect start of a multiline value for a known key
    if (writtenKeys.has(key)) {
      if (
        (restTrimmed.startsWith("'") || restTrimmed.startsWith('"')) &&
        !restTrimmed.slice(1).endsWith(restTrimmed[0])
      ) {
        insideMultiline = true;
        multilineQuote = restTrimmed[0];
      }
      continue; // known key — will be rewritten
    }

    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      extraLines.push(line);
    }
  }

  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value.includes("\n")) {
      // Multiline: single-quoted block matching the fr-config-manager sample format
      lines.push(`${key}='${value}'`);
    } else {
      lines.push(`${key}=${value}`);
    }
  }

  if (extraLines.length > 0) {
    lines.push("", ...extraLines);
  }

  return lines.join("\n") + "\n";
}
