export const MAX_SSE_BUFFER_CHARS = 1024 * 1024;
export const MAX_SSE_EVENT_DATA_CHARS = 512 * 1024;
export const MAX_DEDUP_IDS = 200;

export function parseSseFieldValue(line: string, prefixLength: number): string {
  let value = line.slice(prefixLength);
  if (value.startsWith(' ')) {
    value = value.slice(1);
  }
  return value;
}

export interface ParsedSseEvent {
  event: string;
  data: string;
  id: string;
}

export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ParsedSseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let currentData = '';
  let hasDataField = false;
  let currentId = '';

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > MAX_SSE_BUFFER_CHARS) {
      throw new Error('SSE frame exceeds parser buffer limit');
    }

    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r(?=.)/g, '\n');
    if (buffer.endsWith('\r')) {
      continue;
    }

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = parseSseFieldValue(line, 6);
      } else if (line.startsWith('data:')) {
        hasDataField = true;
        const nextData = (currentData ? '\n' : '') + parseSseFieldValue(line, 5);
        if (currentData.length + nextData.length > MAX_SSE_EVENT_DATA_CHARS) {
          throw new Error('SSE event exceeds parser data limit');
        }
        currentData += nextData;
      } else if (line.startsWith('id:')) {
        currentId = parseSseFieldValue(line, 3);
      } else if (line === '') {
        if (hasDataField) {
          yield { event: currentEvent || 'message', data: currentData, id: currentId };
        }
        currentEvent = '';
        currentData = '';
        hasDataField = false;
        currentId = '';
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.endsWith('\r')) {
    buffer = `${buffer.slice(0, -1)}\n`;
  }

  if (buffer) {
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = parseSseFieldValue(line, 6);
      } else if (line.startsWith('data:')) {
        hasDataField = true;
        const nextData = (currentData ? '\n' : '') + parseSseFieldValue(line, 5);
        if (currentData.length + nextData.length > MAX_SSE_EVENT_DATA_CHARS) {
          throw new Error('SSE event exceeds parser data limit');
        }
        currentData += nextData;
      } else if (line.startsWith('id:')) {
        currentId = parseSseFieldValue(line, 3);
      } else if (line === '') {
        if (hasDataField) {
          yield { event: currentEvent || 'message', data: currentData, id: currentId };
        }
        currentEvent = '';
        currentData = '';
        hasDataField = false;
        currentId = '';
      }
    }
  }

  if (hasDataField) {
    yield { event: currentEvent || 'message', data: currentData, id: currentId };
  }
}

export function createDedupSet(): { has: (id: string) => boolean; add: (id: string) => void } {
  const ids: string[] = [];
  const idSet = new Set<string>();
  return {
    has(id: string): boolean {
      return idSet.has(id);
    },
    add(id: string): void {
      if (!id || idSet.has(id)) {
        return;
      }
      ids.push(id);
      idSet.add(id);
      while (ids.length > MAX_DEDUP_IDS) {
        const evicted = ids.shift();
        if (evicted) {
          idSet.delete(evicted);
        }
      }
    },
  };
}
