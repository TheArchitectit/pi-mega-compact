import { openStore } from '../dist/src/store/sqlite.js';
import { appendRawTranscript, listRawTranscriptRange, writeCheckpointEpoch, readCheckpointEpoch, getActiveEpochForSession } from '../dist/src/store/sqlite.js';
import { epochNonceFor, epochIdFor } from '../dist/src/mirror/epoch.js';
import { rmSync } from 'node:fs';

const dir = 'tmp/audit-db';
rmSync(dir, { recursive: true, force: true });
const db = openStore(dir);

// epoch determinism
const n1 = epochNonceFor('cp_abc');
const n2 = epochNonceFor('cp_abc');
const n3 = epochNonceFor('cp_abd');
console.log('nonce stable:', n1 === n2, 'diff input diff:', n1 !== n3, 'nonce unsigned:', Number.isInteger(n1) && n1 >= 0, n1.toString(16));
console.log('epochId:', epochIdFor('cp_abc'));

// append + idempotent (INSERT OR IGNORE keyed on content_hash,session_id)
appendRawTranscript(db, { contentHash: 'h1', sessionId: 's1', seq: 0, role: 'user', contentBytes: 'b1', toolName: null, messageTimestamp: 1000, checkpointEpoch: 'epoch:cpA' });
appendRawTranscript(db, { contentHash: 'h1', sessionId: 's1', seq: 0, role: 'user', contentBytes: 'b1', toolName: null, messageTimestamp: 1000, checkpointEpoch: 'epoch:cpA' }); // dup -> ignore
appendRawTranscript(db, { contentHash: 'h2', sessionId: 's1', seq: 0, role: 'assistant', contentBytes: 'b2', toolName: 'tool', messageTimestamp: 1001, checkpointEpoch: 'epoch:cpA' });
// different session, same content_hash -> must NOT collide
appendRawTranscript(db, { contentHash: 'h1', sessionId: 's2', seq: 0, role: 'user', contentBytes: 'b1-s2', toolName: null, messageTimestamp: 2000, checkpointEpoch: 'epoch:cpB' });

const rows = listRawTranscriptRange(db, 's1', 1, 2);
console.log('rows s1:', rows.map(r => `${r.seq}:${r.contentHash}:${r.role}:${r.toolName}:${r.checkpointEpoch}`));
const rowsS2 = listRawTranscriptRange(db, 's2', 1, 1);
console.log('rows s2 (no collision):', rowsS2.map(r => `${r.contentHash}:${r.contentBytes}`));
console.log('seq monotonic:', rows[0].seq === 1 && rows[1].seq === 2);

// epoch upsert / refresh
const e1 = { epochId: 'epoch:cpA', sessionId: 's1', startedSeq: 1, committedSeq: 2, summaryMessageText: 'sum1', cutIndex: 0, checkpointId: 'cpA', createdAt: 5000 };
writeCheckpointEpoch(db, e1);
writeCheckpointEpoch(db, { ...e1, createdAt: 9000, committedSeq: 3 }); // refresh
const read = readCheckpointEpoch(db, 'epoch:cpA');
console.log('epoch refresh committedSeq/createdAt:', read?.committedSeq, read?.createdAt);
console.log('active epoch for s1:', JSON.stringify(getActiveEpochForSession(db, 's1')?.epochId));
const activeNone = getActiveEpochForSession(db, 'no-session');
console.log('active none:', activeNone);
const readNone = readCheckpointEpoch(db, 'nope');
console.log('read none:', readNone);
db.close();
rmSync(dir, { recursive: true, force: true });
