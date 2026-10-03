import type { Download } from '../api';

import { IconShieldAlert, IconShieldCheck } from './icons';
import * as m from '../paraglide/messages';

const KIND: Record<NonNullable<Download['hashType']>, string> = {
  md5: 'MD5',
  sha1: 'SHA-1',
  sha256: 'SHA-256',
  mega: 'MEGA-MAC',
};

/** The result of the checksum check after the download (JD: "CRC OK"). */
export function HashBadge({ d }: { d: Download }) {
  if (d.hashOk === null || !d.hashType) return null;
  const kind = KIND[d.hashType] ?? d.hashType.toUpperCase();
  return d.hashOk ? (
    <span className="hash-badge ok" title={m.hash_okTitle({ kind })}>
      <IconShieldCheck size={13} />
      {m.hash_ok()}
      <span className="hash-kind">{kind}</span>
    </span>
  ) : (
    <span className="hash-badge bad" title={m.hash_badTitle({ kind })}>
      <IconShieldAlert size={13} />
      {m.hash_bad()}
    </span>
  );
}
