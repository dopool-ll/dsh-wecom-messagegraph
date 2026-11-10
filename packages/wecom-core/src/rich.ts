import {createHash} from 'node:crypto';
import {basename} from 'node:path';
import {decodeText, fields} from './protobuf';
import type {MessageDetail, MessagePart, Platform} from './types';

export const mediaLabels = {
  image: '图片', video: '视频', voice: '语音', file: '文件', sticker: '表情',
} as const;
export type MediaKind = keyof typeof mediaLabels;
export interface MediaHint {
  kind: MediaKind;
  paths: string[];
  keys: string[];
  names: string[];
  size?: number;
  nameSize?: number;
  digest?: string;
}
export type DecodedPart = Omit<MessagePart, 'localMedia'> & {asset?: MediaHint};
type Decoded = DecodedPart | {kind: 'mixed'; text: string; placeholder: false; parts: DecodedPart[]};
type Fields = ReturnType<typeof fields>;

const utf8 = new TextDecoder('utf-8', {fatal: true});
const invalidText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const value = (items: Fields, tag: number) => items.find(field => field.number === tag)?.value;
function parse(payload: unknown): Fields {
  if (!(payload instanceof Uint8Array) || payload.length > 1024 * 1024) return [];
  try { return fields(payload); } catch { return []; }
}
function utf8Text(bytes: unknown, max: number) {
  if (!(bytes instanceof Uint8Array) || bytes.length > max * 4) return undefined;
  try {
    const text = utf8.decode(bytes);
    return text && !invalidText.test(text) ? text.slice(0, max) : undefined;
  } catch { return undefined; }
}
function string(items: Fields, tag: number, max = 4096) {
  return utf8Text(value(items, tag), max);
}
function number(items: Fields, tag: number, max: number) {
  const n = value(items, tag);
  return typeof n === 'bigint' && n > 0 && n <= BigInt(max) ? Number(n) : undefined;
}
function url(text?: string) {
  if (!text) return undefined;
  try {
    const link = new URL(text);
    return ['https:', 'http:'].includes(link.protocol) && !link.username && !link.password ? text : undefined;
  } catch { return undefined; }
}
const hash = (text?: string) => text ? createHash('md5').update(text).digest('hex') : undefined;
const cacheKey = (text?: string) => text && /^[0-9a-f]{32}$/i.test(text) ? text.toLowerCase() : undefined;
const present = (items: Array<string | undefined>) => items.filter((text): text is string => Boolean(text));
const leaf = (text?: string) => text ? basename(text.replaceAll('\\', '/')).trim() || undefined : undefined;

function inlineText(items: Fields) {
  return items.filter(field => field.number === 1).map(part => {
    const wrapped = parse(part.value);
    const data = parse(value(wrapped, 2));
    switch (value(wrapped, 1)) {
      case 0n:
      case 3n: return string(data, 1, 65536) ?? string(wrapped, 2, 65536) ?? '';
      case 5n: {
        const name = string(data, 2, 160);
        return name ? (name.startsWith('@') ? name : '@' + name) : '';
      }
      default: return '';
    }
  }).join('').slice(0, 65536);
}

function media(kind: MediaKind, detail: MessageDetail, asset: Omit<MediaHint, 'kind'>): DecodedPart {
  return {
    kind, detail, asset: {kind, ...asset},
    text: `[${mediaLabels[kind]}]${detail.name && kind === 'file' ? ' ' + detail.name : ''}`,
    placeholder: false,
  };
}

const mixedFields = new Map([[2, 101], [14, 103], [29, 106]]);

function unknown(kind: unknown): DecodedPart {
  return {kind: 'unknown', text: `[消息类型 ${kind == null ? '未知' : String(kind)}]`, placeholder: true};
}

export function decodeMessage(platform: Platform, rawKind: unknown, payload: unknown): Decoded {
  if (platform !== 'macos' || Number(rawKind) !== 123) return decodePart(platform, rawKind, payload);
  const parts = parse(payload).filter(field => field.number === 1).slice(0, 64).map(field => {
    const wrapper = parse(field.value);
    const kind = value(wrapper, 5);
    const tag = typeof kind === 'bigint' ? mixedFields.get(Number(kind)) : undefined;
    const data = tag !== undefined ? value(wrapper, tag) : undefined;
    return data instanceof Uint8Array ? decodePart(platform, kind, data) : unknown(kind);
  });
  if (parts.length === 0) return {kind: 'unknown', text: '[图文消息暂无法解析]', placeholder: true};
  return {kind: 'mixed', text: parts.map(part => part.text).join(' '), placeholder: false, parts};
}

function decodePart(platform: Platform, rawKind: unknown, payload: unknown): DecodedPart {
  const k = Number(rawKind);
  if (k === 2 || (k === 0 && platform === 'macos')) {
    const formatted = platform === 'macos' ? inlineText(parse(payload)) : '';
    const text = formatted || decodeText(payload);
    return text ? {kind: 'text', text, placeholder: false}
      : {kind: 'text', text: '[文本暂无法解析]', placeholder: true};
  }
  if (platform === 'macos') {
    const f = parse(payload);
    const s = (tag: number) => string(f, tag);
    const paths = (...tags: number[]) => present(tags.map(s).filter(name => name?.startsWith('/')));
    const names = (...tags: number[]) => present(tags.map(tag => leaf(s(tag))));
    const bytes = (tag: number) => number(f, tag, Number.MAX_SAFE_INTEGER);
    const seconds = (tag: number) => number(f, tag, 86_400);
    const describe = (kind: MessagePart['kind'], text: string, detail?: MessageDetail): DecodedPart =>
      ({kind, text, detail, placeholder: false});
    switch (k) {
      case 14: case 101: case 653:
        return media('image', {bytes: bytes(4), width: number(f, 5, 65535), height: number(f, 6, 65535)}, {
          paths: paths(100, 202, 2), names: names(2), nameSize: bytes(4),
          keys: present([cacheKey(s(10)), hash(url(s(3))), hash(url(s(26))), hash(url(s(25)))]),
          digest: cacheKey(s(10)),
        });
      case 16:
        return media('voice', {seconds: seconds(7), bytes: bytes(4)}, {
          paths: paths(2), names: [], keys: present([cacheKey(s(10))]),
        });
      case 22: case 23: case 652: case 655:
        return media('video', {seconds: seconds(4), bytes: bytes(3), name: leaf(s(107) ?? s(20) ?? s(1))}, {
          paths: paths(202, 1), names: names(202, 20, 107, 1), keys: present([hash(s(2))]), nameSize: bytes(3),
        });
      case 8: case 15: case 20: case 102: case 651: case 654:
        return media('file', {name: leaf(s(2)), bytes: bytes(4)}, {
          paths: paths(100, 202, 25, 3, 2), names: names(2), keys: [], size: bytes(4),
        });
      case 104:
        return media('sticker', {}, {paths: paths(1), names: [], keys: present([hash(url(s(1)))])});
      case 29:
        if (f.length) return media('sticker', {}, {
          paths: [], names: [], keys: present([cacheKey(s(6)), hash(url(s(1))), hash(url(s(12)))]),
        });
        break;
      case 13:
        return describe('link', s(3) ?? '[链接]', {description: s(4)?.slice(0, 500), url: url(s(1))});
      case 31: {
        const card = parse(value(f, 1));
        return describe('link', string(card, 1, 500) ?? '[链接卡片]', {
          url: url(string(card, 5)) ?? url(string(card, 6)) ?? url(string(card, 2)),
        });
      }
      case 6:
        return describe('location', s(4) ?? s(3) ?? '[位置]', {description: s(4) && s(3)});
      case 41: return describe('card', s(3) ?? '[联系人名片]');
      case 573: return describe('card', s(1) ?? '[消息卡片]');
      case 4: case 673:
        return describe('forward', s(2) ?? '[合并转发]', {count: f.filter(p => p.number === 1).length || undefined});
      case 40: return describe('system', s(3) ?? '[通话]');
      case 1011: return describe('system', '[撤回消息]');
      case 1052: return describe('system', utf8Text(payload, 160)?.trim() || '置顶了一条消息');
    }
  }
  return unknown(rawKind);
}
