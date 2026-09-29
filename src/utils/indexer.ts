/**
 * BM25 search index with Porter stemming and bigram support.
 */

import { PorterStemmer } from "./porter-stemmer.js";
import { STOP_WORDS, PRESERVE_TERMS } from "./stopwords.js";

/** Tokenization patterns */
const TOKEN_RE = /[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/g;
const CAMELCASE_RE = /(?<=[a-z])(?=[A-Z])/;

/** Markdown patterns for weighted extraction */
const MD_HEADER_RE = /^#{1,6}\s+(.+)$/gm;
const MD_CODE_BLOCK_RE = /```[\w]*\n([\s\S]*?)```/g;
const MD_INLINE_CODE_RE = /`([^`]+)`/g;
const MD_LINK_TEXT_RE = /\[([^\]]+)\]\([^)]+\)/g;

/** BM25 parameters */
const K1 = 1.5;
const B = 0.75;

/** Title boost constants */
const TITLE_BOOST_EMPTY = 8;
const TITLE_BOOST_SHORT = 5;
const TITLE_BOOST_LONG = 3;
const SHORT_PAGE_THRESHOLD = 800;

/** Field weights, mirroring the previous scoring multipliers. */
const HEADER_WEIGHT = 4;
const CODE_WEIGHT = 2;
const LINK_WEIGHT = 2;
const CONTENT_WEIGHT = 1;

export interface Doc {
  uri: string;
  displayTitle: string;
  content: string;
  indexTitle: string;
}

export interface SearchResult {
  score: number;
  doc: Doc;
}

/**
 * Generate bigrams from a list of tokens.
 */
function generateBigrams(tokens: string[]): string[] {
  const bigrams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.push(`${tokens[i]}_${tokens[i + 1]}`);
  }
  return bigrams;
}

/**
 * Enhanced tokenization with stemming and stopword removal.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const matches = text.match(TOKEN_RE) || [];

  for (const token of matches) {
    // Split hyphenated terms into parts
    const parts = token.includes("-") ? token.split("-") : [token];

    for (const part of parts) {
      const partLower = part.toLowerCase();

      // Skip empty parts or stop words
      if (!partLower || STOP_WORDS.has(partLower)) continue;

      // Preserve domain-specific terms without stemming
      if (PRESERVE_TERMS.has(partLower)) {
        tokens.push(partLower);
        continue;
      }

      // Split CamelCase tokens
      if (/[a-z][A-Z]/.test(part)) {
        const camelParts = part.split(CAMELCASE_RE);
        for (const camelPart of camelParts) {
          const camelLower = camelPart.toLowerCase();
          if (camelLower && !STOP_WORDS.has(camelLower)) {
            if (PRESERVE_TERMS.has(camelLower)) {
              tokens.push(camelLower);
            } else {
              const stemmed = PorterStemmer.stem(camelLower);
              if (!STOP_WORDS.has(stemmed)) {
                tokens.push(stemmed);
              }
            }
          }
        }
        // Also add stemmed original if meaningful
        const stemmedOriginal = PorterStemmer.stem(partLower);
        if (!STOP_WORDS.has(stemmedOriginal) && !tokens.includes(stemmedOriginal)) {
          tokens.push(stemmedOriginal);
        }
      } else {
        const stemmed = PorterStemmer.stem(partLower);
        if (!STOP_WORDS.has(stemmed)) {
          tokens.push(stemmed);
        }
      }
    }
  }

  return tokens;
}

/**
 * Get title boost factor based on content length.
 */
function getTitleBoost(doc: Doc): number {
  const n = doc.content.length;
  if (n === 0) return TITLE_BOOST_EMPTY;
  if (n < SHORT_PAGE_THRESHOLD) return TITLE_BOOST_SHORT;
  return TITLE_BOOST_LONG;
}

/**
 * Extract all matches from regex and join them.
 */
function extractMatches(text: string, regex: RegExp): string {
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match[1] || match[0]);
  }
  return matches.join(" ");
}

/**
 * Add every token (and the bigrams within the token list) to a per-doc
 * weighted term-frequency map, each occurrence contributing `weight`. Bigrams
 * are taken over the field's own token list, so an adjacent-term (phrase) match
 * within a field carries that field's weight.
 */
function accumulateWeightedTf(
  tf: Map<string, number>,
  tokens: string[],
  weight: number
): void {
  if (weight <= 0 || tokens.length === 0) return;
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + weight);
  for (const bg of generateBigrams(tokens)) tf.set(bg, (tf.get(bg) || 0) + weight);
}

/**
 * BM25 inverted index with Markdown awareness.
 */
export class IndexSearch {
  private docs: Doc[] = [];
  private docFrequency: Map<string, number> = new Map();
  private docIndices: Map<string, number[]> = new Map();
  private docLengths: number[] = [];
  private termFreqs: Map<string, number>[] = [];
  private totalDocLength: number = 0;
  private avgDocLength: number = 0;

  /**
   * Add a document to the search index.
   */
  add(doc: Doc): this {
    const idx = this.docs.length;
    this.docs.push(doc);

    // Precompute lowercased fields + Markdown extracts once. store.ts always
    // passes content: "", so header/code/link weighting is dead in production;
    // skip the regex extraction entirely when content is empty (extractMatches
    // over "" yields "", so the result is unchanged).
    const titleBoost = getTitleBoost(doc);
    const titleLower = doc.indexTitle.toLowerCase();
    const hasContent = doc.content.length > 0;
    const contentLower = hasContent ? doc.content.toLowerCase() : "";
    const headersLower = hasContent ? extractMatches(doc.content, MD_HEADER_RE).toLowerCase() : "";
    const codeLower = hasContent ? extractMatches(doc.content, MD_CODE_BLOCK_RE).toLowerCase() : "";
    const inlineLower = hasContent ? extractMatches(doc.content, MD_INLINE_CODE_RE).toLowerCase() : "";
    const linkLower = hasContent ? extractMatches(doc.content, MD_LINK_TEXT_RE).toLowerCase() : "";

    // Tokenize each field once. The field order matches the previous single
    // haystack (title, headers, link, code, inline, content), so concatenating
    // the field token lists reproduces the old tokenize(haystack) stream exactly
    // (tokenization is per whitespace-separated run and independent of context).
    // Postings, document frequencies, and document lengths are therefore
    // unchanged from before.
    const titleTokens = tokenize(titleLower);
    const headerTokens = tokenize(headersLower);
    const linkTokens = tokenize(linkLower);
    const codeTokens = tokenize(codeLower);
    const inlineTokens = tokenize(inlineLower);
    const contentTokens = tokenize(contentLower);

    // Per-doc weighted term frequencies, built from the same tokens used for
    // indexing rather than by substring-scanning raw text. Field weights mirror
    // the previous scoring: title x its length-based boost, headers x4, code x2,
    // link x2, content x1. As before, header/code/link/inline text also appears
    // inside `content`, so those matches accumulate the field weight on top of
    // the content weight. Inline code gets no separate weight (its text is
    // already counted via `content`), matching the old scoring which never read
    // the inline extract. Because the map is keyed by the indexed tokens, bigram
    // and stemmed matches now score instead of being silently dropped by the old
    // substring counting.
    const termFreq = new Map<string, number>();
    accumulateWeightedTf(termFreq, titleTokens, titleBoost);
    accumulateWeightedTf(termFreq, headerTokens, HEADER_WEIGHT);
    accumulateWeightedTf(termFreq, codeTokens, CODE_WEIGHT);
    accumulateWeightedTf(termFreq, linkTokens, LINK_WEIGHT);
    accumulateWeightedTf(termFreq, contentTokens, CONTENT_WEIGHT);
    this.termFreqs.push(termFreq);

    // Full unigram stream (haystack order) plus bigrams over the whole stream.
    const unigrams = [
      ...titleTokens,
      ...headerTokens,
      ...linkTokens,
      ...codeTokens,
      ...inlineTokens,
      ...contentTokens,
    ];
    const bigrams = generateBigrams(unigrams);
    const allTokens = [...unigrams, ...bigrams];

    // Record each token in the posting list at most once per document, so a
    // term repeated within a document is not scored once per occurrence during
    // search. Document frequency is likewise counted once per document.
    const seen = new Set<string>();
    for (const tok of allTokens) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      const indices = this.docIndices.get(tok) || [];
      indices.push(idx);
      this.docIndices.set(tok, indices);
      this.docFrequency.set(tok, (this.docFrequency.get(tok) || 0) + 1);
    }

    // Store document length and maintain a running total, so the average is
    // O(1) per add instead of a full reduce (previously O(n^2) build).
    this.docLengths.push(allTokens.length);
    this.totalDocLength += allTokens.length;
    this.avgDocLength = this.totalDocLength / this.docLengths.length;

    return this;
  }

  /**
   * Search the index and return ranked results.
   */
  search(query: string, k: number = 8): SearchResult[] {
    if (this.docs.length === 0) return [];

    // Tokenize query
    const qUnigrams = tokenize(query);
    const qBigrams = generateBigrams(qUnigrams);
    const qTokens = [...qUnigrams, ...qBigrams];

    const scores = new Map<number, number>();

    for (const qt of qTokens) {
      const indices = this.docIndices.get(qt) || [];
      for (const idx of indices) {
        const score = this.calculateBM25Score(qt, idx);
        scores.set(idx, (scores.get(idx) || 0) + score);
      }
    }

    // Sort by score descending
    const ranked = Array.from(scores.entries())
      .map(([idx, score]) => ({ score, doc: this.docs[idx] }))
      .sort((a, b) => b.score - a.score);

    return ranked.slice(0, k);
  }

  /**
   * Calculate the BM25 score for a token in a document, reading the precomputed
   * weighted term frequency rather than scanning raw text.
   */
  private calculateBM25Score(token: string, docIdx: number): number {
    const weightedTf = this.termFreqs[docIdx].get(token) || 0;
    if (weightedTf === 0) return 0;

    // Document length
    const docLength = this.docLengths[docIdx] || 1;
    const avgLen = Math.max(this.avgDocLength, 1);

    // BM25 IDF
    const nDocs = Math.max(this.docs.length, 1);
    const df = this.docFrequency.get(token) || 0;
    const idf = Math.log((nDocs - df + 0.5) / (df + 0.5) + 1.0);

    // BM25 TF with length normalization
    const tfComponent =
      (weightedTf * (K1 + 1)) /
      (weightedTf + K1 * (1 - B + B * (docLength / avgLen)));

    return idf * tfComponent;
  }

  /**
   * Get all indexed documents.
   */
  getDocs(): readonly Doc[] {
    return this.docs;
  }

  /**
   * Get the number of indexed documents.
   */
  get size(): number {
    return this.docs.length;
  }
}
