// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable @typescript-eslint/no-namespace */

import { escapeRegExp, isNumber, omit } from 'lodash';

import { SignalService as Proto } from '../protobuf';
import * as log from '../logging/log';
import { missingCaseError } from '../util/missingCaseError';
import type { ConversationType } from '../state/ducks/conversations';
import {
  SNIPPET_LEFT_PLACEHOLDER,
  SNIPPET_RIGHT_PLACEHOLDER,
  SNIPPET_TRUNCATION_PLACEHOLDER,
} from '../util/search';
import { assertDev } from '../util/assert';

// Cold storage of body ranges

export type BodyRange<T extends object> = {
  start: number;
  length: number;
} & T;

/** Body range as parsed from proto (No "Link" since those don't come from proto) */
export type RawBodyRange = BodyRange<BodyRange.Mention | BodyRange.Formatting>;

export enum DisplayStyle {
  SearchKeywordHighlight = 'SearchKeywordHighlight',
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export namespace BodyRange {
  // re-export for convenience
  export type Style = Proto.DataMessage.BodyRange.Style;
  export const { Style } = Proto.DataMessage.BodyRange;

  export type Mention = {
    mentionUuid: string;
  };
  export type Link = {
    url: string;
  };
  export type Formatting = {
    style: Style;
    spoilerId?: number;
  };
  export type DisplayOnly = {
    displayStyle: DisplayStyle;
  };

  export function isRawRange(range: BodyRange<object>): range is RawBodyRange {
    return isMention(range) || isFormatting(range);
  }

  // these overloads help inference along
  export function isMention(
    bodyRange: HydratedBodyRangeType
  ): bodyRange is HydratedBodyRangeMention;
  export function isMention(
    bodyRange: BodyRange<object>
  ): bodyRange is BodyRange<Mention>;
  export function isMention<T extends object, X extends BodyRange<Mention> & T>(
    bodyRange: BodyRange<T>
  ): bodyRange is X {
    // satisfies keyof Mention
    return ('mentionUuid' as const) in bodyRange;
  }
  export function isFormatting(
    bodyRange: BodyRange<object>
  ): bodyRange is BodyRange<Formatting> {
    // satisfies keyof Formatting
    return ('style' as const) in bodyRange;
  }

  export function isLink<T extends Mention | Link | Formatting | DisplayOnly>(
    node: T
  ): node is T & Link {
    // satisfies keyof Link
    return ('url' as const) in node;
  }
  export function isDisplayOnly<
    T extends Mention | Link | Formatting | DisplayOnly
  >(node: T): node is T & DisplayOnly {
    // satisfies keyof DisplayOnly
    return ('displayStyle' as const) in node;
  }
}

// Used exclusive in CompositionArea and related conversation_view.tsx calls.

export type DraftBodyRangeMention = BodyRange<
  BodyRange.Mention & {
    replacementText: string;
  }
>;
export type DraftBodyRange =
  | DraftBodyRangeMention
  | BodyRange<BodyRange.Formatting>;
export type DraftBodyRanges = ReadonlyArray<DraftBodyRange>;

// Fully hydrated body range to be used in UI components.

export type HydratedBodyRangeMention = DraftBodyRangeMention & {
  conversationID: string;
};

export type HydratedBodyRangeType =
  | HydratedBodyRangeMention
  | BodyRange<BodyRange.Formatting>;

export type HydratedBodyRangesType = ReadonlyArray<HydratedBodyRangeType>;

export type DisplayBodyRangeType =
  | HydratedBodyRangeType
  | BodyRange<BodyRange.DisplayOnly>;
export type BodyRangesForDisplayType = ReadonlyArray<DisplayBodyRangeType>;

type HydratedMention = BodyRange.Mention & {
  conversationID: string;
  replacementText: string;
};

/**
 * A range that can contain other nested ranges
 * Inner range start fields are relative to the start of the containing range
 */
export type RangeNode = BodyRange<
  (
    | HydratedMention
    | BodyRange.Link
    | BodyRange.Formatting
    | BodyRange.DisplayOnly
  ) & {
    ranges: ReadonlyArray<RangeNode>;
  }
>;

const { BOLD, ITALIC, MONOSPACE, SPOILER, STRIKETHROUGH, NONE } =
  BodyRange.Style;
const MAX_PER_TYPE = 250;
const MENTION_NAME = 'mention';

// We drop unknown bodyRanges and remove extra stuff so they serialize properly
export function filterAndClean(
  ranges: ReadonlyArray<Proto.DataMessage.IBodyRange> | undefined | null
): ReadonlyArray<RawBodyRange> | undefined {
  if (!ranges) {
    return undefined;
  }

  const countByTypeRecord: Record<
    BodyRange.Style | typeof MENTION_NAME,
    number
  > = {
    [MENTION_NAME]: 0,
    [BOLD]: 0,
    [ITALIC]: 0,
    [MONOSPACE]: 0,
    [SPOILER]: 0,
    [STRIKETHROUGH]: 0,
    [NONE]: 0,
  };

  return ranges
    .filter((range: Proto.DataMessage.IBodyRange): range is RawBodyRange => {
      if (!isNumber(range.start)) {
        log.warn('filterAndClean: Dropping bodyRange with non-number start');
        return false;
      }
      if (!isNumber(range.length)) {
        log.warn('filterAndClean: Dropping bodyRange with non-number length');
        return false;
      }

      if (range.mentionUuid) {
        countByTypeRecord[MENTION_NAME] += 1;
        if (countByTypeRecord[MENTION_NAME] > MAX_PER_TYPE) {
          return false;
        }
        return true;
      }
      if (range.style) {
        countByTypeRecord[range.style] += 1;
        if (countByTypeRecord[range.style] > MAX_PER_TYPE) {
          return false;
        }
        return true;
      }

      log.warn('filterAndClean: Dropping unknown bodyRange');
      return false;
    })
    .map(range => ({ ...range }));
}

export function hydrateRanges(
  ranges: ReadonlyArray<BodyRange<object>> | undefined,
  conversationSelector: (id: string) => ConversationType
): Array<HydratedBodyRangeType> | undefined {
  if (!ranges) {
    return undefined;
  }

  return filterAndClean(ranges)?.map(range => {
    if (BodyRange.isMention(range)) {
      const conversation = conversationSelector(range.mentionUuid);

      return {
        ...range,
        conversationID: conversation.id,
        replacementText: conversation.title,
      };
    }

    return range;
  });
}

/**
 * Insert a range into an existing range tree, splitting up the range if it intersects
 * with an existing range
 *
 * @param range The range to insert the tree
 * @param rangeTree A list of nested non-intersecting range nodes, these starting ranges
 *  will not be split up
 */
export function insertRange(
  range: BodyRange<
    | HydratedMention
    | BodyRange.Link
    | BodyRange.Formatting
    | BodyRange.DisplayOnly
  >,
  rangeTree: ReadonlyArray<RangeNode>
): ReadonlyArray<RangeNode> {
  const [current, ...rest] = rangeTree;

  if (!current) {
    return [{ ...range, ranges: [] }];
  }
  const rangeEnd = range.start + range.length;
  const currentEnd = current.start + current.length;

  // ends before current starts
  if (rangeEnd <= current.start) {
    return [{ ...range, ranges: [] }, current, ...rest];
  }

  // starts after current one ends
  if (range.start >= currentEnd) {
    return [current, ...insertRange(range, rest)];
  }

  // range is contained by first
  if (range.start >= current.start && rangeEnd <= currentEnd) {
    return [
      {
        ...current,
        ranges: insertRange(
          { ...range, start: range.start - current.start },
          current.ranges
        ),
      },
      ...rest,
    ];
  }

  // range contains first (but might contain more)
  // split range into 3
  if (range.start < current.start && rangeEnd > currentEnd) {
    return [
      { ...range, length: current.start - range.start, ranges: [] },
      {
        ...current,
        ranges: insertRange(
          { ...range, start: 0, length: current.length },
          current.ranges
        ),
      },
      ...insertRange(
        { ...range, start: currentEnd, length: rangeEnd - currentEnd },
        rest
      ),
    ];
  }

  // range intersects beginning
  // split range into 2
  if (range.start < current.start && rangeEnd <= currentEnd) {
    return [
      { ...range, length: current.start - range.start, ranges: [] },
      {
        ...current,
        ranges: insertRange(
          {
            ...range,
            start: 0,
            length: range.length - (current.start - range.start),
          },
          current.ranges
        ),
      },
      ...rest,
    ];
  }

  // range intersects ending
  // split range into 2
  if (range.start >= current.start && rangeEnd > currentEnd) {
    return [
      {
        ...current,
        ranges: insertRange(
          {
            ...range,
            start: range.start - current.start,
            length: currentEnd - range.start,
          },
          current.ranges
        ),
      },
      ...insertRange(
        {
          ...range,
          start: currentEnd,
          length: range.length - (currentEnd - range.start),
        },
        rest
      ),
    ];
  }

  log.error(`MessageTextRenderer: unhandled range ${range}`);
  throw new Error('unhandled range');
}

// A flat list, ready for display

export type DisplayNode = {
  text: string;
  start: number;
  length: number;
  mentions: ReadonlyArray<BodyRange<HydratedMention>>;

  // Formatting
  isBold?: boolean;
  isItalic?: boolean;
  isMonospace?: boolean;
  isSpoiler?: boolean;
  isStrikethrough?: boolean;

  // Link
  url?: string;

  // DisplayOnly
  isKeywordHighlight?: boolean;

  // Only for spoilers, only to make sure we honor original spoiler breakdown
  spoilerId?: number;
  spoilerChildren?: ReadonlyArray<DisplayNode>;
};
type PartialDisplayNode = Omit<
  DisplayNode,
  'mentions' | 'text' | 'start' | 'length'
>;

function rangeToPartialNode(
  range: BodyRange<
    BodyRange.Link | BodyRange.Formatting | BodyRange.DisplayOnly
  >
): PartialDisplayNode {
  if (BodyRange.isFormatting(range)) {
    if (range.style === BodyRange.Style.BOLD) {
      return { isBold: true };
    }
    if (range.style === BodyRange.Style.ITALIC) {
      return { isItalic: true };
    }
    if (range.style === BodyRange.Style.MONOSPACE) {
      return { isMonospace: true };
    }
    if (range.style === BodyRange.Style.SPOILER) {
      return { isSpoiler: true, spoilerId: range.spoilerId };
    }
    if (range.style === BodyRange.Style.STRIKETHROUGH) {
      return { isStrikethrough: true };
    }
    if (range.style === BodyRange.Style.NONE) {
      return {};
    }
    throw missingCaseError(range.style);
  }
  if (BodyRange.isLink(range)) {
    return {
      url: range.url,
    };
  }
  if (BodyRange.isDisplayOnly(range)) {
    if (range.displayStyle === DisplayStyle.SearchKeywordHighlight) {
      return { isKeywordHighlight: true };
    }
    throw missingCaseError(range.displayStyle);
  }

  throw missingCaseError(range);
}

/**
 * Turns a range tree into a flat list that can be rendered, with a walk across the tree.
 *
 *  * @param rangeTree A list of nested non-intersecting ranges.
 */
export function collapseRangeTree({
  parentData,
  parentOffset = 0,
  text,
  tree,
}: {
  parentData?: PartialDisplayNode;
  parentOffset?: number;
  text: string;
  tree: ReadonlyArray<RangeNode>;
}): ReadonlyArray<DisplayNode> {
  let collapsed: Array<DisplayNode> = [];

  let offset = 0;
  let mentions: Array<HydratedBodyRangeMention> = [];

  tree.forEach(range => {
    if (BodyRange.isMention(range)) {
      mentions.push({
        ...omit(range, ['ranges']),
        start: range.start - offset,
      });
      return;
    }

    // Empty space between start of current
    if (range.start > offset) {
      collapsed.push({
        ...parentData,
        text: text.slice(offset, range.start),
        start: offset + parentOffset,
        length: range.start - offset,
        mentions,
      });
      mentions = [];
    }

    // What sub-breaks can we make within this node?
    const partialNode = { ...parentData, ...rangeToPartialNode(range) };
    collapsed = collapsed.concat(
      collapseRangeTree({
        parentData: partialNode,
        parentOffset: range.start + parentOffset,
        text: text.slice(range.start, range.start + range.length),
        tree: range.ranges,
      })
    );

    offset = range.start + range.length;
  });

  // Empty space after the last range
  if (text.length > offset) {
    collapsed.push({
      ...parentData,
      text: text.slice(offset, text.length),
      start: offset + parentOffset,
      length: text.length - offset,
      mentions,
    });
  }

  return collapsed;
}

export function groupContiguousSpoilers(
  nodes: ReadonlyArray<DisplayNode>
): ReadonlyArray<DisplayNode> {
  const result: Array<DisplayNode> = [];

  let spoilerContainer: DisplayNode | undefined;

  nodes.forEach(node => {
    if (node.isSpoiler) {
      if (
        spoilerContainer &&
        isNumber(spoilerContainer.spoilerId) &&
        spoilerContainer.spoilerId === node.spoilerId
      ) {
        spoilerContainer.spoilerChildren = [
          ...(spoilerContainer.spoilerChildren || []),
          node,
        ];
      } else {
        spoilerContainer = undefined;
      }

      if (!spoilerContainer) {
        spoilerContainer = {
          ...node,
          isSpoiler: true,
          spoilerChildren: [node],
        };
        result.push(spoilerContainer);
      }
    } else {
      spoilerContainer = undefined;
      result.push(node);
    }
  });

  return result;
}

const TRUNCATION_CHAR = '...';
const TRUNCATION_START = new RegExp(`^${SNIPPET_TRUNCATION_PLACEHOLDER}`);
const TRUNCATION_END = new RegExp(`${SNIPPET_TRUNCATION_PLACEHOLDER}$`);
// This function exists because bodyRanges tells us the character position
// where the at-mention starts at according to the full body text. The snippet
// we get back is a portion of the text and we don't know where it starts. This
// function will find the relevant bodyRanges that apply to the snippet and
// then update the proper start position of each body range.
export function processBodyRangesForSearchResult({
  snippet,
  body,
  bodyRanges,
}: {
  snippet: string;
  body: string;
  bodyRanges: BodyRangesForDisplayType;
}): {
  cleanedSnippet: string;
  bodyRanges: BodyRangesForDisplayType;
} {
  // Find where the snippet starts in the full text
  const cleanedSnippet = snippet
    .replace(new RegExp(SNIPPET_LEFT_PLACEHOLDER, 'g'), '')
    .replace(new RegExp(SNIPPET_RIGHT_PLACEHOLDER, 'g'), '');
  const withNoStartTruncation = cleanedSnippet.replace(TRUNCATION_START, '');
  const withNoEndTruncation = withNoStartTruncation.replace(TRUNCATION_END, '');
  const finalSnippet = cleanedSnippet
    .replace(TRUNCATION_START, TRUNCATION_CHAR)
    .replace(TRUNCATION_END, TRUNCATION_CHAR);
  const truncationDelta =
    withNoStartTruncation.length !== cleanedSnippet.length
      ? TRUNCATION_CHAR.length
      : 0;
  const rx = new RegExp(escapeRegExp(withNoEndTruncation));
  const match = rx.exec(body);

  assertDev(Boolean(match), `No match found for "${snippet}" inside "${body}"`);

  const startOfSnippet = match ? match.index : 0;
  const endOfSnippet = startOfSnippet + withNoEndTruncation.length;

  // We want only the ranges that include the snippet
  const filteredBodyRanges = bodyRanges.filter(range => {
    const { start } = range;
    const end = range.start + range.length;
    return end > startOfSnippet && start < endOfSnippet;
  });

  // Adjust ranges, with numbers for the original message body, to work with snippet
  const adjustedBodyRanges: Array<DisplayBodyRangeType> =
    filteredBodyRanges.map(range => {
      const normalizedStart = range.start - startOfSnippet + truncationDelta;
      const start = Math.max(normalizedStart, truncationDelta);
      const end = Math.min(
        normalizedStart + range.length,
        withNoEndTruncation.length + truncationDelta
      );

      return {
        ...range,
        start,
        length: end - start,
      };
    });

  // To format the matches identified by FTS, we create synthetic BodyRanges to mix in
  // with all the other formatting embedded in this message.
  const highlightMatches = snippet.matchAll(
    new RegExp(
      `${SNIPPET_LEFT_PLACEHOLDER}(.*?)${SNIPPET_RIGHT_PLACEHOLDER}`,
      'dg'
    )
  );

  let placeholderCharsSkipped = 0;
  for (const highlightMatch of highlightMatches) {
    // TS < 5 does not have types for RegExpIndicesArray
    const { indices } = highlightMatch as RegExpMatchArray & {
      indices: Array<Array<number>>;
    };
    const [wholeMatchStartIdx] = indices[0];
    const [matchedWordStartIdx, matchedWordEndIdx] = indices[1];
    adjustedBodyRanges.push({
      start:
        wholeMatchStartIdx +
        -placeholderCharsSkipped +
        (truncationDelta
          ? TRUNCATION_CHAR.length - SNIPPET_TRUNCATION_PLACEHOLDER.length
          : 0),
      length: matchedWordEndIdx - matchedWordStartIdx,
      displayStyle: DisplayStyle.SearchKeywordHighlight,
    });
    placeholderCharsSkipped +=
      SNIPPET_LEFT_PLACEHOLDER.length + SNIPPET_RIGHT_PLACEHOLDER.length;
  }

  return {
    cleanedSnippet: finalSnippet,
    bodyRanges: adjustedBodyRanges,
  };
}

export const SPOILER_REPLACEMENT = '■■■■';

export function applyRangesForText({
  text,
  mentions,
  spoilers,
}: {
  text: string | undefined;
  mentions: ReadonlyArray<HydratedBodyRangeMention>;
  spoilers: ReadonlyArray<BodyRange<BodyRange.Formatting>>;
}): string | undefined {
  if (!text) {
    return text;
  }

  let updatedText = text;
  let sortableMentions: Array<HydratedBodyRangeMention> = mentions.slice();

  const sortableSpoilers: Array<BodyRange<BodyRange.Formatting>> =
    spoilers.slice();
  updatedText = sortableSpoilers
    .sort((a, b) => b.start - a.start)
    .reduce((acc, { start, length }) => {
      const left = acc.slice(0, start);
      const end = start + length;
      const right = acc.slice(end);

      // Note: this is a simplified filter because mentions always have length=1
      sortableMentions = sortableMentions
        .filter(mention => {
          return mention.start < start || mention.start >= end;
        })
        .map(mention => {
          if (mention.start >= end) {
            return {
              ...mention,
              start: mention.start - (length - SPOILER_REPLACEMENT.length),
            };
          }

          return mention;
        });

      return `${left}${SPOILER_REPLACEMENT}${right}`;
    }, updatedText);

  return sortableMentions
    .sort((a, b) => b.start - a.start)
    .reduce((acc, { start, length, replacementText }) => {
      const left = acc.slice(0, start);
      const right = acc.slice(start + length);
      return `${left}@${replacementText}${right}`;
    }, updatedText);
}
