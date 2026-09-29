/**
 * Porter stemmer (Porter's original 1980 algorithm).
 *
 * Vendored, unchanged in behavior, from `natural`
 * (https://github.com/NaturalNode/natural), file
 * `lib/natural/stemmers/porter_stemmer.js`, to drop the heavyweight `natural`
 * dependency (which pulled mongoose/mongodb/redis/pg/memjs/wordnet-db and
 * printed dotenv output to stdout on import) while producing byte-for-byte
 * identical stem output. Only the self-contained `stem` routine and its
 * helpers are ported; the `Stemmer` base class (tokenizer/stopword helpers)
 * was not needed.
 *
 * Original work:
 *   Copyright (c) 2011, Chris Umbel
 *   Licensed under the MIT License (text below).
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

type Replacement = [string | RegExp, string, string];

// Denote groups of consecutive consonants with a C and consecutive vowels
// with a V.
function categorizeGroups(token: string): string {
  return token
    .replace(/[^aeiouy]+y/g, "CV")
    .replace(/[aeiou]+/g, "V")
    .replace(/[^V]+/g, "C");
}

// Denote single consonants with a C and single vowels with a V.
function categorizeChars(token: string): string {
  return token
    .replace(/[^aeiouy]y/g, "CV")
    .replace(/[aeiou]/g, "V")
    .replace(/[^V]/g, "C");
}

// Calculate the "measure" M of a word. M is the count of VC sequences dropping
// an initial C if it exists and a trailing V if it exists.
function measure(token: string): number {
  if (!token) return -1;
  return categorizeGroups(token).replace(/^C/, "").replace(/V$/, "").length / 2;
}

// Determine if a token ends with a double consonant e.g. "happ".
function endsWithDoublCons(token: string): RegExpMatchArray | null {
  return token.match(/([^aeiou])\1$/);
}

// Replace a pattern in a word. If a replacement occurs an optional callback can
// be called to post-process the result. If no match is made null is returned.
function attemptReplace(
  token: string,
  pattern: string | RegExp,
  replacement: string,
  callback?: (t: string) => string | null
): string | null {
  let result: string | null = null;

  if (typeof pattern === "string" && token.substr(0 - pattern.length) === pattern) {
    result = token.replace(new RegExp(pattern + "$"), replacement);
  } else if (pattern instanceof RegExp && token.match(pattern)) {
    result = token.replace(pattern, replacement);
  }

  if (result && callback) {
    return callback(result);
  } else {
    return result;
  }
}

// Attempt to replace a list of patterns/replacements on a token for a minimum
// measure M.
function attemptReplacePatterns(
  token: string,
  replacements: Replacement[],
  measureThreshold?: number | null
): string {
  let replacement = token;

  for (let i = 0; i < replacements.length; i++) {
    if (
      measureThreshold == null ||
      measure(attemptReplace(token, replacements[i][0], replacements[i][1]) ?? "") > measureThreshold
    ) {
      replacement = attemptReplace(replacement, replacements[i][0], replacements[i][2]) || replacement;
    }
  }

  return replacement;
}

// Replace a list of patterns/replacements on a word. If no match is made return
// the original token.
function replacePatterns(
  token: string,
  replacements: Replacement[],
  measureThreshold?: number | null
): string {
  return attemptReplacePatterns(token, replacements, measureThreshold) || token;
}

function replaceRegex(
  token: string,
  regex: RegExp,
  includeParts: number[],
  minimumMeasure: number
): string | null {
  let result = "";

  if (regex.test(token)) {
    const parts = regex.exec(token);
    if (parts) {
      for (const i of includeParts) {
        result += parts[i];
      }
    }
  }

  if (measure(result) > minimumMeasure) {
    return result;
  }

  return null;
}

// Step 1a.
function step1a(token: string): string {
  if (token.match(/(ss|i)es$/)) {
    return token.replace(/(ss|i)es$/, "$1");
  }

  if (token.substr(-1) === "s" && token.substr(-2, 1) !== "s" && token.length > 2) {
    return token.replace(/s?$/, "");
  }

  return token;
}

// Step 1b.
function step1b(token: string): string {
  let result: string | null;
  if (token.substr(-3) === "eed") {
    if (measure(token.substr(0, token.length - 3)) > 0) {
      return token.replace(/eed$/, "ee");
    }
  } else {
    result = attemptReplace(token, /(ed|ing)$/, "", function (token: string): string | null {
      if (categorizeGroups(token).indexOf("V") >= 0) {
        result = attemptReplacePatterns(token, [
          ["at", "", "ate"],
          ["bl", "", "ble"],
          ["iz", "", "ize"],
        ]);

        if (result !== token) {
          return result;
        } else {
          if (endsWithDoublCons(token) && token.match(/[^lsz]$/)) {
            return token.replace(/([^aeiou])\1$/, "$1");
          }

          if (measure(token) === 1 && categorizeChars(token).substr(-3) === "CVC" && token.match(/[^wxy]$/)) {
            return token + "e";
          }
        }

        return token;
      }

      return null;
    });

    if (result) {
      return result;
    }
  }

  return token;
}

// Step 1c.
function step1c(token: string): string {
  const categorizedGroups = categorizeGroups(token);

  if (token.substr(-1) === "y" && categorizedGroups.substr(0, categorizedGroups.length - 1).indexOf("V") > -1) {
    return token.replace(/y$/, "i");
  }

  return token;
}

// Step 2.
function step2(token: string): string {
  token = replacePatterns(
    token,
    [
      ["ational", "", "ate"],
      ["tional", "", "tion"],
      ["enci", "", "ence"],
      ["anci", "", "ance"],
      ["izer", "", "ize"],
      ["abli", "", "able"],
      ["bli", "", "ble"],
      ["alli", "", "al"],
      ["entli", "", "ent"],
      ["eli", "", "e"],
      ["ousli", "", "ous"],
      ["ization", "", "ize"],
      ["ation", "", "ate"],
      ["ator", "", "ate"],
      ["alism", "", "al"],
      ["iveness", "", "ive"],
      ["fulness", "", "ful"],
      ["ousness", "", "ous"],
      ["aliti", "", "al"],
      ["iviti", "", "ive"],
      ["biliti", "", "ble"],
      ["logi", "", "log"],
    ],
    0
  );

  return token;
}

// Step 3.
function step3(token: string): string {
  return replacePatterns(
    token,
    [
      ["icate", "", "ic"],
      ["ative", "", ""],
      ["alize", "", "al"],
      ["iciti", "", "ic"],
      ["ical", "", "ic"],
      ["ful", "", ""],
      ["ness", "", ""],
    ],
    0
  );
}

// Step 4.
function step4(token: string): string {
  return (
    replaceRegex(
      token,
      /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/,
      [1],
      1
    ) ||
    replaceRegex(token, /^(.+?)(s|t)(ion)$/, [1, 2], 1) ||
    token
  );
}

// Step 5a.
function step5a(token: string): string {
  const m = measure(token.replace(/e$/, ""));

  if (m > 1 || (m === 1 && !(categorizeChars(token).substr(-4, 3) === "CVC" && token.match(/[^wxy].$/)))) {
    token = token.replace(/e$/, "");
  }

  return token;
}

// Step 5b.
function step5b(token: string): string {
  if (measure(token) > 1) {
    return token.replace(/ll$/, "l");
  }

  return token;
}

/** Perform the full Porter stemming algorithm on a single word. */
export function stem(token: string): string {
  if (token.length < 3) return token;
  return step5b(step5a(step4(step3(step2(step1c(step1b(step1a(token.toLowerCase()))))))));
}

/**
 * Drop-in replacement for `natural`'s `PorterStemmer` (only the `stem` method
 * is used in this codebase).
 */
export const PorterStemmer = { stem };
