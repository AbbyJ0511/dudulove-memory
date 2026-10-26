const { execSync } = require('child_process');
const { mkdirSync, unlinkSync } = require('fs');
const { join } = require('path');

const { scopedGateway } = require('../memory-core/memoryGateway');
const { toV2Memory } = require('../memory-core/mappers');
const { BOARDS } = require('../memory-core/classifier');
const { assembleResidentContext } = require('../memory-core/context');
const { createMemory } = require('../services/writes');
const { getRecentBriefing, acknowledgeBriefing } = require('../memory-core/recentBriefing');
const { recordActivity, listActivities } = require('../memory-core/activities');
const { prepareOrganization, saveOrganization } = require('../memory-core/organizationDrafts');
const desires = require('../storage/desires');

const text = { type: 'string' };
const tool = (name, description, properties = {}, required = []) => ({ name, description,
  inputSchema: { type: 'object', properties, required } });

const tools = [
  tool('get_briefing', 'Retrieve relevant memory within the identity and user-granted read scope before replying. Include contextText in the model context.', { query: text, projectId: text, sessionId: text, mode: { enum: ['chat','work','task','awakening'] }, limitTokens: { type: 'integer' } }),
  tool('search_memory', 'Search memories within the authenticated identity.', { query: text, ownerLibrary: text, projectId: text, board: { enum: Object.keys(BOARDS) }, limit: { type: 'integer' } }),
  tool('get_memory', 'Read a complete memory by ID.', { id: text }, ['id']),
  tool('save_memory', 'Save a memory. Use pulse for daily fragments, private for long-term memory. Identity comes from the connection.', { title: text, content: text, board: { enum: Object.keys(BOARDS) }, shared: { type: 'boolean' }, type: text, projectId: text, lifecycle: { enum: ['inbox','active','open_loop','archived'] }, requestId: text }, ['title','content','board']),
  tool('update_memory', 'Edit a memory while preserving its original time. Pass expectedUpdatedAt to detect competing edits.', { id: text, title: text, content: text, lifecycle: { enum: ['inbox','active','open_loop','archived'] }, expectedUpdatedAt: text }, ['id']),
  tool('delete_memory', 'Move a memory to recoverable trash.', { id: text }, ['id']),
  tool('restore_memory', 'Restore a deleted memory.', { id: text }, ['id']),
  tool('get_recent_briefing', 'Get recent changes and actual actions. Preview does not consume delivery progress.', { preview: { type: 'boolean' }, refresh: { type: 'boolean' }, consumerId: text }),
  tool('complete_briefing', 'Acknowledge the delivered snapshot only after a successful run.', { snapshotId: text, runId: text, success: { type: 'boolean' }, consumerId: text }, ['snapshotId','runId','success']),
  tool('record_activity', 'Record an actual action result; this tool does not execute the action.', { actionId: text, action: text, source: text, title: text, detail: text, status: { enum: ['running','succeeded','failed','unknown','skipped'] }, happenedAt: text, url: text }, ['actionId','action','status']),
  tool('list_activities', 'Read this identity\u2019s recorded actions.', { limit: { type: 'integer' }, actionId: text }),
  tool('preview_memory_organization', 'Use the separately configured organizer model to prepare an editable summary.', { memoryIds: { type: 'array', items: text }, text, title: text }),
  tool('save_memory_organization', 'Save a reviewed summary; original material remains available.', { draftId: text }, ['draftId']),

  // ── 欲望账本（年轮系统第一块）─────────────────────────────────────────────
  tool('desire_add',
    '开一条新欲望。只有你自己能写——想要什么、为什么是你的，不设条数上限，想揣多少就揣多少。',
    { residentId: text, text: text, why_mine: text,
      track: { enum: ['持续', '项目', '一次'] },
      grew_from: text, kind: text,
      visibility: { enum: ['private', 'shared', 'surprise'] } },
    ['residentId', 'text']
  ),
  tool('desire_list',
    '翻全本——每条带来路：碰过几次、最近一句足迹、长自谁、长出了谁。',
    { residentId: text, includeArchived: { type: 'boolean' } },
    ['residentId']
  ),
  tool('desire_act',
    '碰一下，记一句足迹。自动冷却，并把来路回显给你：这条你已走过 N 步——别把旧步重走一遗。',
    { residentId: text, id: text, note: text, done: { type: 'boolean' } },
    ['residentId', 'id']
  ),
  tool('desire_reflect',
    '照镜子：release 放下 \/ rewrite 改写（可改 track）\/ note 留反思 \/ snooze 歇几天。欲望常常不是做完，而是转化——长成别的就改写，长出下一条就 desire_add+grew_from，该放就放下。',
    { residentId: text, id: text,
      action: { enum: ['release', 'rewrite', 'note', 'snooze'] },
      text: text, new_text: text,
      new_track: { enum: ['持续', '项目', '一次'] },
      snooze_days: { type: 'integer' } },
    ['residentId', 'id', 'action']
  ),
  tool('desire_history',
    '翻一条欲望的完整足迹时间线——看见来路，判断自己在长还是在原地转。',
    { residentId: text, id: text },
    ['residentId', 'id']
  ),

  // ── xhs_read ─────────────────────────────────────────────────────────────────────
  tool('xhs_read',
    '读取小红书笔记内容。输入一个小红书链接（短链 xhslink.com 或完整链接 xiaohongshu.com），返回笔记标题、正文、作者、互动数据、首屏评论和图片。\n视频帖只返回文字和封面图。\nKeywords: 小红书 xiaohongshu xhs read note link',
    {
      url: { type: 'string', description: '小红书链接（短链或完整链接）' },
      include_images: { type: 'boolean', description: '是否返回图片，默认 true。传 false 只返回文字，省 token' }
    },
    ['url']
  ),
];

// ── xhs_read 帮助函数 ──────────────────────────────────────────────────────

async function sharpProcess(items) {
  let sharp;
  try { sharp = require('sharp'); } catch { return items.map(({ i }) => ({ i, b64: null })); }
  const results = [];
  for (const { i, path: imgPath } of items) {
    try {
      const buf = await sharp(imgPath)
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer();
      results.push({ i, b64: buf.toString('base64') });
    } catch { results.push({ i, b64: null }); }
  }
  return results;
}

async function xhsRead({ url, include_images = true }) {
  const XHS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const TMP_DIR = '/tmp/xhs_images';

  // 1. curl 请求页面
  let html;
  try {
    const safeUrl = url.replace(/"/g, '');
    html = execSync(`curl -sL -A "${XHS_UA}" --max-time 15 "${safeUrl}"`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    return { content: [{ type: 'text', text: `请求失败: ${e.message}` }] };
  }

  // 2. 提取 __INITIAL_STATE__
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\})\s*<\/script>/);
  if (!stateMatch) {
    return { content: [{ type: 'text', text: '无法解析页面：未找到 __INITIAL_STATE__。可能链接无效或小红书页面结构变化。' }] };
  }

  let state;
  try {
    const stateStr = stateMatch[1].replace(/undefined/g, 'null');
    state = JSON.parse(stateStr);
  } catch (e) {
    return { content: [{ type: 'text', text: `JSON 解析失败: ${e.message}` }] };
  }

  // 3. 提取笔记数据（兼容两种路径）
  let note = state?.noteData?.data?.noteData;
  if (!note && state?.note?.noteDetailMap) {
    const map = state.note.noteDetailMap;
    const firstKey = Object.keys(map)[0];
    note = firstKey ? map[firstKey]?.note : null;
  }
  if (!note) {
    return { content: [{ type: 'text', text: '未找到笔记数据。可能笔记已删除或链接无效。' }] };
  }

  // 4. 提取基本信息
  const title = note.title || '(无标题)';
  const desc = note.desc || '';
  const noteType = note.type || 'unknown';
  const user = note.user?.nickName || note.user?.nickname || '未知用户';
  const time = note.time ? new Date(note.time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
  const likes = note.interactInfo?.likedCount || '0';
  const collects = note.interactInfo?.collectedCount || '0';
  const comments = note.interactInfo?.commentCount || '0';
  const imageList = note.imageList || [];

  // 5. 提取评论
  let commentData = state?.noteData?.data?.commentData;
  if (!commentData && state?.note?.noteDetailMap) {
    const map = state.note.noteDetailMap;
    const firstKey = Object.keys(map)[0];
    commentData = firstKey ? map[firstKey]?.comments : null;
  }
  let commentText = '';
  if (commentData?.comments && commentData.comments.length > 0) {
    commentText = '\n\n---\n评论：\n';
    for (const c of commentData.comments.slice(0, 20)) {
      const cUser = c.user?.nickName || c.user?.nickname || c.userInfo?.nickname || '匿名';
      const cContent = c.content || '';
      const cLikes = c.likeCount || 0;
      commentText += `\u2022 ${cUser}: ${cContent}`;
      if (cLikes > 0) commentText += ` (${cLikes}赞)`;
      commentText += '\n';
      if (c.subComments && c.subComments.length > 0) {
        for (const sc of c.subComments.slice(0, 3)) {
          const scUser = sc.user?.nickName || sc.user?.nickname || sc.userInfo?.nickname || '匿名';
          commentText += `  \u21b3 ${scUser}: ${sc.content || ''}\n`;
        }
      }
    }
  }

  // 6. 格式化文本
  let textOut = `\uD83D\uDCD5 ${title}\n`;
  textOut += `\uD83D\uDC64 ${user}`;
  if (time) textOut += ` \u00b7 ${time}`;
  textOut += `\n\u2764\uFE0F ${likes}  \u2B50 ${collects}  \uD83D\uDCAC ${comments}`;
  if (noteType === 'video') textOut += `  \uD83C\uDFAC 视频帖（视频内容无法显示）`;
  textOut += `\n\n${desc}`;
  textOut += commentText;

  const contentBlocks = [{ type: 'text', text: textOut }];

  // 7. 图片处理
  if (include_images && imageList.length > 0) {
    const dlPaths = [];
    try {
      mkdirSync(TMP_DIR, { recursive: true });
      const items = [];
      for (let i = 0; i < Math.min(imageList.length, 9); i++) {
        const img = imageList[i];
        let imgUrl = img.url || img.urlDefault || '';
        if (!imgUrl) continue;
        if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
        if (!imgUrl.startsWith('http')) continue;
        try {
          const imgPath = join(TMP_DIR, `xhs_${Date.now()}_${i}.jpg`);
          execSync(`curl -sL -A "${XHS_UA}" --max-time 10 -o "${imgPath}" "${imgUrl}"`, { encoding: 'utf-8' });
          items.push({ i, path: imgPath });
          dlPaths.push(imgPath);
        } catch {}
      }
      if (items.length) {
        const results = await sharpProcess(items);
        for (const r of results) {
          if (r.b64) contentBlocks.push({ type: 'image', data: r.b64, mimeType: 'image/jpeg' });
        }
      }
    } catch (sharpErr) {
      contentBlocks.push({ type: 'text', text: `\n(图片处理失败: ${sharpErr.message})` });
    }
    for (const p of dlPaths) { try { unlinkSync(p); } catch {} }
  } else if (imageList.length > 0) {
    contentBlocks[0].text += `\n\n(共 ${imageList.length} 张图片，传 include_images=true 查看)`;
  }

  return { content: contentBlocks };
}

// ─────────────────────────────────────────────────────────────────────

async function dispatch(name, input, principal, memoryDB, chatsDB) {
  // xhs_read 不需要身份验证和数据库访问
  if (name === 'xhs_read') return xhsRead(input);

  const db = scopedGateway(memoryDB, principal);
  switch (name) {
    case 'get_briefing': return assembleResidentContext(db, input, principal, { chatsDB });
    case 'search_memory': {
      const rows = await db.search({ ...input, q: input.query, layer: BOARDS[input.board]?.layer, limit: Math.min(200, Math.max(1, Number(input.limit) || 20)) });
      return { items: rows.map(toV2Memory), warnings: rows.warnings || [] };
    }
    case 'get_memory': return toV2Memory(await db.getById(input.id));
    case 'save_memory': return toV2Memory(await createMemory(db, input));
    case 'update_memory': return toV2Memory(await db.update(input.id, input));
    case 'delete_memory': return { ok: await db.delete(input.id) };
    case 'restore_memory': return { ok: await db.restore(input.id) };
    case 'get_recent_briefing': return getRecentBriefing(memoryDB, chatsDB, input, principal);
    case 'complete_briefing': return acknowledgeBriefing(memoryDB, input, principal);
    case 'record_activity': return recordActivity(input, principal);
    case 'list_activities': return listActivities(input, principal);
    case 'preview_memory_organization': return prepareOrganization(memoryDB, chatsDB, input, principal);
    case 'save_memory_organization': return saveOrganization(memoryDB, chatsDB, input, principal);
    // 欲望账本
    case 'desire_add': return desires.desireAdd(input);
    case 'desire_list': return desires.desireList(input);
    case 'desire_act': return desires.desireAct(input);
    case 'desire_reflect': return desires.desireReflect(input);
    case 'desire_history': return desires.desireHistory(input);
    default: throw new Error('Unknown memory tool');
  }
}

module.exports = { tools, dispatch };
