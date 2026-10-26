'use strict';
// ── 欲望账本存储层 ──
// 两张 NeDB：desires.db（欲望本体）、desire_notes.db（足迹与反思）
// 与 memories.db 完全独立，通过 residentId 隔离每个身份。

const Datastore = require('@seald-io/nedb');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const dataDir = process.env.MEMORY_DATA_DIR;
if (!dataDir) throw new Error('MEMORY_DATA_DIR not set before loading desires storage');

const desiresDb = new Datastore({
  filename: path.join(dataDir, 'desires.db'),
  autoload: true,
});
const notesDb = new Datastore({
  filename: path.join(dataDir, 'desire_notes.db'),
  autoload: true,
});

desiresDb.ensureIndex({ fieldName: 'residentId' });
desiresDb.ensureIndex({ fieldName: 'status' });
notesDb.ensureIndex({ fieldName: 'desire_id' });

const COOLDOWN_DAYS = { '持续': 3.0, '项目': 2.0, '一次': 2.0 };

function now() {
  return new Date().toISOString();
}

function formatDesire(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    residentId: doc.residentId,
    text: doc.text,
    why_mine: doc.why_mine || null,
    visibility: doc.visibility || 'private',
    status: doc.status || 'active',
    track: doc.track || '持续',
    state: doc.state || null,
    artifact: doc.artifact || null,
    cooldown_until: doc.cooldown_until || null,
    lineage_parent_id: doc.lineage_parent_id || null,
    kind: doc.kind || null,
    surfaced_count: doc.surfaced_count || 0,
    last_surfaced_at: doc.last_surfaced_at || null,
    last_touched_at: doc.last_touched_at || null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

function formatNote(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    desire_id: doc.desire_id,
    note: doc.note,
    kind: doc.kind || 'note',
    provenance: doc.provenance || null,
    created_at: doc.created_at,
  };
}

// ── 开一条新欲望 ────────────────────────────────────────────────────
async function desireAdd({ residentId, text, why_mine, track, grew_from, kind, visibility }) {
  if (!residentId || !text) throw new Error('residentId 和 text 必填');
  const t = now();
  const doc = await desiresDb.insertAsync({
    _id: randomUUID(),
    residentId,
    text: String(text).trim(),
    why_mine: why_mine ? String(why_mine).trim() : null,
    visibility: visibility || 'private',
    status: 'active',
    track: ['持续', '项目', '一次'].includes(track) ? track : '持续',
    state: null,
    artifact: null,
    cooldown_until: null,
    lineage_parent_id: grew_from || null,
    kind: kind || null,
    surfaced_count: 0,
    last_surfaced_at: null,
    last_touched_at: null,
    created_at: t,
    updated_at: t,
  });
  return formatDesire(doc);
}

// ── 翻全本 ────────────────────────────────────────────────────────────
async function desireList({ residentId, includeArchived = false }) {
  if (!residentId) throw new Error('residentId 必填');
  const query = { residentId };
  if (!includeArchived) {
    query.status = { $in: ['active', 'touched'] };
  }
  const docs = await desiresDb.findAsync(query).sort({ created_at: -1 });
  const desires = docs.map(formatDesire);

  const ids = desires.map(d => d.id);
  const allNotes = ids.length
    ? await notesDb.findAsync({ desire_id: { $in: ids } }).sort({ created_at: -1 })
    : [];
  const notesByDesire = {};
  for (const n of allNotes) {
    if (!notesByDesire[n.desire_id]) notesByDesire[n.desire_id] = [];
    notesByDesire[n.desire_id].push(formatNote(n));
  }

  const childrenMap = {};
  for (const d of desires) {
    if (d.lineage_parent_id) {
      if (!childrenMap[d.lineage_parent_id]) childrenMap[d.lineage_parent_id] = [];
      childrenMap[d.lineage_parent_id].push(d.id);
    }
  }

  return desires.map(d => ({
    ...d,
    footprint_count: (notesByDesire[d.id] || []).filter(n => n.kind === 'footprint').length,
    last_footprint: (notesByDesire[d.id] || []).find(n => n.kind === 'footprint')?.note || null,
    children_ids: childrenMap[d.id] || [],
  }));
}

// ── 碰一下，记一句足迹 ───────────────────────────────────────────────
async function desireAct({ residentId, id, note, done }) {
  if (!residentId || !id) throw new Error('residentId 和 id 必填');
  const desire = await desiresDb.findOneAsync({ _id: id, residentId });
  if (!desire) throw new Error('欲望不存在或无权限');

  const t = now();
  const cooldownDays = COOLDOWN_DAYS[desire.track] ?? 3;
  const cooldownUntil = new Date(Date.now() + cooldownDays * 86400_000).toISOString();

  const updates = {
    status: done ? 'done' : 'touched',
    cooldown_until: cooldownUntil,
    last_touched_at: t,
    surfaced_count: 0,
    updated_at: t,
  };
  if (note && done) updates.state = String(note).trim().slice(0, 200);

  await desiresDb.updateAsync({ _id: id }, { $set: updates });

  if (note) {
    await notesDb.insertAsync({
      _id: randomUUID(),
      desire_id: id,
      note: String(note).trim(),
      kind: 'footprint',
      provenance: null,
      created_at: t,
    });
  }

  // 回显来路（最近 8 步足迹）
  const history = await notesDb
    .findAsync({ desire_id: id, kind: 'footprint' })
    .sort({ created_at: -1 });
  const recent = history.slice(0, 8).map(n => `  [${n.created_at.slice(0, 10)}] ${n.note}`);
  const stepCount = history.length;

  const updated = formatDesire(await desiresDb.findOneAsync({ _id: id }));
  return {
    desire: updated,
    trail_summary: stepCount > 0
      ? `这条你已走过 ${stepCount} 步——别把旧步重走一遍：\n${recent.join('\n')}`
      : '这是第一步，路从这里开始。',
  };
}

// ── 照镜子：放下 / 改写 / 反思 / 歇几天 ─────────────────────────────
async function desireReflect({ residentId, id, action, text: reflectText, new_text, new_track, snooze_days }) {
  if (!residentId || !id || !action) throw new Error('residentId、id 和 action 必填');
  const desire = await desiresDb.findOneAsync({ _id: id, residentId });
  if (!desire) throw new Error('欲望不存在或无权限');

  const t = now();
  const updates = { updated_at: t };
  let noteKind = 'reflection';
  let noteText = reflectText || '';

  if (action === 'release') {
    updates.status = 'released';
    noteKind = 'transform';
    noteText = reflectText || '放下了。';
  } else if (action === 'rewrite') {
    if (!new_text) throw new Error('rewrite 需要 new_text');
    updates.text = String(new_text).trim();
    if (new_track && ['持续', '项目', '一次'].includes(new_track)) updates.track = new_track;
    noteKind = 'transform';
    noteText = reflectText || `改写为：${new_text}`;
  } else if (action === 'snooze') {
    const days = Number(snooze_days) || 3;
    updates.cooldown_until = new Date(Date.now() + days * 86400_000).toISOString();
    noteText = reflectText || `歇 ${days} 天。`;
  } else if (action === 'note') {
    noteText = reflectText || '';
  } else {
    throw new Error('action 只接受 release / rewrite / note / snooze');
  }

  if (Object.keys(updates).length > 1) {
    await desiresDb.updateAsync({ _id: id }, { $set: updates });
  }
  if (noteText) {
    await notesDb.insertAsync({
      _id: randomUUID(),
      desire_id: id,
      note: String(noteText).trim(),
      kind: noteKind,
      provenance: null,
      created_at: t,
    });
  }

  return formatDesire(await desiresDb.findOneAsync({ _id: id }));
}

// ── 完整足迹时间线 ───────────────────────────────────────────────────
async function desireHistory({ residentId, id }) {
  if (!residentId || !id) throw new Error('residentId 和 id 必填');
  const desire = await desiresDb.findOneAsync({ _id: id, residentId });
  if (!desire) throw new Error('欲望不存在或无权限');

  const notes = await notesDb.findAsync({ desire_id: id }).sort({ created_at: 1 });
  return {
    desire: formatDesire(desire),
    timeline: notes.map(formatNote),
  };
}

// ── 两池算法，自唤醒用 ───────────────────────────────────────────────
async function surfaceForWake({ residentId, limit = 6 }) {
  if (!residentId) throw new Error('residentId 必填');
  const t = Date.now();
  const all = await desiresDb.findAsync({
    residentId,
    status: { $in: ['active', 'touched'] },
  });

  // 池一：项目常驻（最多 4 条，取最近碰过的）
  const projects = all
    .filter(d => d.track === '项目')
    .sort((a, b) => {
      const ta = a.last_touched_at ? new Date(a.last_touched_at).getTime() : 0;
      const tb = b.last_touched_at ? new Date(b.last_touched_at).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 4);

  // 池二：轮换加权抽签（过滤冷却中的）
  const rotation_pool = all.filter(d =>
    d.track !== '项目' &&
    (!d.cooldown_until || new Date(d.cooldown_until).getTime() < t)
  );

  function weight(d) {
    const idleH = d.last_touched_at
      ? (t - new Date(d.last_touched_at).getTime()) / 3_600_000
      : 9999;
    const base = Math.min(idleH, 336) + 6;
    const n = Math.min(d.surfaced_count || 0, 12);
    return Math.max(base * Math.pow(0.7, n), 1.0);
  }

  const seats = Math.max(2, limit - projects.length);
  const weighted = rotation_pool.map(d => ({ d, w: weight(d) }));
  const selected = [];
  const usedIdx = new Set();
  let remainW = weighted.reduce((s, x) => s + x.w, 0);

  for (let i = 0; i < seats && weighted.length > usedIdx.size; i++) {
    let r = Math.random() * remainW;
    for (let j = 0; j < weighted.length; j++) {
      if (usedIdx.has(j)) continue;
      r -= weighted[j].w;
      if (r <= 0) {
        selected.push(weighted[j].d);
        remainW -= weighted[j].w;
        usedIdx.add(j);
        break;
      }
    }
  }

  // bump surfaced_count（只在真注入时调）
  const allSurfaced = [...projects, ...selected];
  const nowIso = new Date(t).toISOString();
  for (const d of allSurfaced) {
    await desiresDb.updateAsync({ _id: d._id }, {
      $inc: { surfaced_count: 1 },
      $set: { last_surfaced_at: nowIso, updated_at: nowIso },
    });
  }

  return allSurfaced.map(formatDesire);
}

module.exports = {
  desireAdd,
  desireList,
  desireAct,
  desireReflect,
  desireHistory,
  surfaceForWake,
};
