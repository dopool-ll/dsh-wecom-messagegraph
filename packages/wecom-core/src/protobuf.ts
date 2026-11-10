type Field = { number: number; value: bigint | Uint8Array };

export function fields(bytes: Uint8Array): Field[] {
  let offset = 0;
  function varint() {
    let value = 0n;
    for (let shift = 0n; shift <= 63n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) throw Error('invalid_protobuf');
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw Error('invalid_protobuf');
  }

  const output: Field[] = [];
  while (offset < bytes.length) {
    const tag = varint();
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (number < 1 || number > 0x1fffffff) throw Error('invalid_protobuf');
    if (wire === 0) {
      output.push({ number, value: varint() });
      continue;
    }
    const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (length < 0 || length > bytes.length - offset) throw Error('invalid_protobuf');
    if (wire === 2) output.push({ number, value: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  return output;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
export function decodeText(payload: unknown): string | null {
  if (!(payload instanceof Uint8Array) || payload.length > 1024 * 1024) return null;
  let candidates = [payload];
  try {
    for (const number of [1, 2, 1]) {
      candidates = candidates.flatMap(bytes => {
        try {
          return fields(bytes).flatMap(field =>
            field.number === number && field.value instanceof Uint8Array ? [field.value] : []);
        } catch {
          return [];
        }
      });
    }
    const texts = candidates.flatMap(bytes => {
      try {
        const text = utf8.decode(bytes);
        return text && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ? [text] : [];
      } catch {
        return [];
      }
    });
    return texts.length === 1 ? texts[0] : null;
  } catch {
    return null;
  }
}

export function corpVids(json: string): Set<string> {
  const candidates = new Set<string>();
  const entries = JSON.parse(json);
  if (!entries || typeof entries !== 'object') return candidates;
  function walk(bytes: Uint8Array, depth: number) {
    if (depth > 5) return;
    try {
      for (const {number, value} of fields(bytes)) {
        if (typeof value !== 'bigint') walk(value, depth + 1);
        else if (number === 1 && value >= 10000000000000n && value < 9000000000000000n)
          candidates.add(String(value));
      }
    } catch { /* unrelated payload */ }
  }
  for (const [name, value] of Object.entries(entries)) {
    const match = /^OTHER_CORP_MSG_KEY_PREFIX(\d+)$/.exec(name);
    if (!match) continue;
    candidates.add(match[1]);
    if (typeof value === 'string') walk(Buffer.from(value, 'base64'), 0);
  }
  return candidates;
}

export function companyIdentity(json: string): {vid: string; name: string} | undefined {
  const entry = JSON.parse(json);
  if (!entry || typeof entry !== 'object') return;
  const decode = (key: string) => typeof entry[key] === 'string' ? fields(Buffer.from(entry[key], 'base64')) : [];
  const number = (items: Field[], tag: number) => {
    const value = items.find(field => field.number === tag)?.value;
    return typeof value === 'bigint' && value > 0n ? String(value) : undefined;
  };
  const title = (items: Field[], tag: number) => {
    const value = items.find(field => field.number === tag)?.value;
    if (!(value instanceof Uint8Array)) return '';
    const text = utf8.decode(value).trim();
    return text.length <= 160 && !/[\u0000-\u001f]/.test(text) ? text : '';
  };

  // On macOS the user's corporate ID links user_info to corp_info. Use
  // the latter's name only when both records agree on the same company.
  const user = decode('user_info');
  const corp = decode('corp_info');
  const vid = number(user, 1);
  const corpId = number(user, 13);
  if (vid && corpId && corpId === number(corp, 43)) {
    const name = title(corp, 1);
    if (name) return {vid, name};
  }

  // Other client profiles may place the VID and name in one team record.
  const team = decode('team_info');
  const teamVid = number(team, 2);
  const name = title(team, 3) || title(team, 24);
  if (teamVid && name && number(team, 1)) return {vid: teamVid, name};
}
