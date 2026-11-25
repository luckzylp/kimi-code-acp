/**
 * ACP prompt blocks → engine prompt parts (ADR 0001, Decision 4).
 *
 * A client sends text, images, `resource_link`s and embedded resources. The
 * engine takes `text` / `image_url` / `video_url` parts, and the SDK's
 * `Session.attachFile` turns bytes into a file id the engine can resolve
 * (`kimi-file://`), so an image becomes: base64 → attachFile → image_url.
 *
 * Files the client links to are read here, on the agent's host, because the
 * engine executes tools there and never sees the client's filesystem.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { Session as KimiSession } from '@moonshot-ai/kimi-code-sdk';
import type { PromptPart } from '@moonshot-ai/kimi-code-sdk';

import { log } from './log';

/** Characters of a linked text file inlined into the prompt. */
const MAX_RESOURCE_CHARS = 128 * 1024;

export interface BuiltPrompt {
  /** The text half, used for slash-command detection and the prompt itself. */
  readonly text: string;
  /** Text first, then media — the shape the engine expects. */
  readonly parts: readonly PromptPart[];
}

export async function buildPrompt(
  session: KimiSession,
  blocks: readonly ContentBlock[],
): Promise<BuiltPrompt> {
  const textBits: string[] = [];
  const media: PromptPart[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        textBits.push(block.text);
        break;
      }
      case 'image': {
        const part = await attach(session, Buffer.from(block.data, 'base64'), {
          name: 'image',
          mimeType: block.mimeType,
          kind: 'image_url',
        });
        if (part !== undefined) media.push(part);
        break;
      }
      case 'resource_link': {
        const contents = await readLinkedResource(block.uri);
        if (contents === undefined) break;
        if (contents.mimeType.startsWith('image/')) {
          const part = await attach(session, contents.bytes, {
            name: block.name,
            mimeType: contents.mimeType,
            kind: 'image_url',
          });
          if (part !== undefined) media.push(part);
          break;
        }
        textBits.push(renderTextResource(block.name, contents.text));
        break;
      }
      case 'resource': {
        const resource = block.resource;
        if ('text' in resource && typeof resource.text === 'string') {
          textBits.push(renderTextResource(resource.uri, resource.text));
        } else if ('blob' in resource && typeof resource.blob === 'string') {
          const mimeType = resource.mimeType ?? 'application/octet-stream';
          if (mimeType.startsWith('image/')) {
            const part = await attach(session, Buffer.from(resource.blob, 'base64'), {
              name: resource.uri,
              mimeType,
              kind: 'image_url',
            });
            if (part !== undefined) media.push(part);
          } else {
            log.debug('acp: embedded non-image resource ignored', { uri: resource.uri, mimeType });
          }
        }
        break;
      }
      default: {
        // audio and future block types have no engine prompt part.
        log.debug('acp: prompt block type not supported', { type: (block as { type?: string }).type });
        break;
      }
    }
  }

  const text = textBits.join('\n\n');
  const parts: PromptPart[] = [];
  if (text.length > 0) parts.push({ type: 'text', text });
  parts.push(...media);
  return { text, parts };
}

async function attach(
  session: KimiSession,
  bytes: Buffer,
  options: { name: string; mimeType: string; kind: 'image_url' },
): Promise<PromptPart | undefined> {
  try {
    // `attachFile` already answers with the `kimi-file://` URL, not a raw id.
    const url = await session.attachFile(bytes, {
      name: options.name,
      mimeType: options.mimeType,
    });
    return { type: options.kind, imageUrl: { url } } as PromptPart;
  } catch (error) {
    log.warn('acp: could not attach prompt media', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function readLinkedResource(
  uri: string,
): Promise<{ mimeType: string; bytes: Buffer; text: string } | undefined> {
  let path: string;
  try {
    path = uri.startsWith('file:') ? fileURLToPath(uri) : uri;
  } catch {
    return undefined;
  }
  if (!path.startsWith('/')) return undefined;
  try {
    const bytes = await readFile(path);
    return { bytes, mimeType: guessMimeType(path), text: bytes.toString('utf8') };
  } catch (error) {
    log.debug('acp: could not read linked resource', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function renderTextResource(name: string, text: string): string {
  const clipped =
    text.length > MAX_RESOURCE_CHARS
      ? `${text.slice(0, MAX_RESOURCE_CHARS)}\n… ${text.length - MAX_RESOURCE_CHARS} characters omitted …`
      : text;
  return `<resource name="${name}">\n${clipped}\n</resource>`;
}

function guessMimeType(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (extension) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'json':
      return 'application/json';
    case 'md':
      return 'text/markdown';
    default:
      return 'text/plain';
  }
}