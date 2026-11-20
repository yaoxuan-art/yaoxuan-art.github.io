/**
 * yaoxuan.xin 后端 — Cloudflare Worker + KV
 *
 * API 路由：
 *   POST /api/vote        — 提交投票 { selections: ["w32","w45","w50"] }
 *   GET  /api/leaderboard — 获取排行榜 { totalVotes: N, works: [{id, votes}, ...] }
 *   POST /api/naming      — 提交作品名 { workId: "w32", name: "星尘裂痕" }
 *   GET  /api/names       — 获取所有作品名数据 { works: { w32: { names:[], adopted:{name,note}, locked:bool }, ... } }
 *
 * 防刷机制：基于 IP 去重
 *   - 投票：每个 IP 只能投一次
 *   - 取名：每个 IP 每张作品只能提交一次
 */

// ===== KV 绑定名 =====
const KV_NAMESPACE = 'VOTE_KV';

// ===== CORS 头 =====
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}

// ===== 投票 =====

async function handleVote(request, env, ctx) {
  try {
    var body = await request.json();
    var selections = body.selections;

    if (!Array.isArray(selections) || selections.length !== 3) {
      return jsonResponse({ error: '请选择 3 张作品' }, 400);
    }

    var validIds = selections.every(function(id) {
      return /^w(3[2-9]|[4-5][0-9])$/.test(id);
    });
    if (!validIds) {
      return jsonResponse({ error: '无效的作品 ID' }, 400);
    }

    var clientIP = request.headers.get('cf-connecting-ip') || 'unknown';
    var voteKey = 'voted:' + clientIP;

    var alreadyVoted = await env[KV_NAMESPACE].get(voteKey);
    if (alreadyVoted) {
      return jsonResponse({ error: '你已经投过票了', alreadyVoted: true }, 403);
    }

    await env[KV_NAMESPACE].put(voteKey, JSON.stringify(selections));

    var voteCountPromises = selections.map(function(workId) {
      return env[KV_NAMESPACE].get('work:' + workId).then(function(val) {
        var count = val ? parseInt(val, 10) : 0;
        return env[KV_NAMESPACE].put('work:' + workId, String(count + 1));
      });
    });
    await Promise.all(voteCountPromises);

    var totalStr = await env[KV_NAMESPACE].get('total');
    var total = totalStr ? parseInt(totalStr, 10) : 0;
    await env[KV_NAMESPACE].put('total', String(total + 1));

    return jsonResponse({ success: true, totalVotes: total + 1 });
  } catch (err) {
    return jsonResponse({ error: '服务器错误: ' + err.message }, 500);
  }
}

async function handleLeaderboard(request, env) {
  try {
    var totalStr = await env[KV_NAMESPACE].get('total');
    var totalVotes = totalStr ? parseInt(totalStr, 10) : 0;

    var workIds = [];
    for (var num = 32; num <= 56; num++) {
      workIds.push('w' + num);
    }

    var works = await Promise.all(workIds.map(function(id) {
      return env[KV_NAMESPACE].get('work:' + id).then(function(val) {
        return { id: id, votes: val ? parseInt(val, 10) : 0 };
      });
    }));

    works.sort(function(a, b) { return b.votes - a.votes; });

    return jsonResponse({
      success: true,
      totalVotes: totalVotes,
      works: works,
    });
  } catch (err) {
    return jsonResponse({ error: '服务器错误: ' + err.message }, 500);
  }
}

// ===== 作品名征集 =====

async function handleNaming(request, env, ctx) {
  try {
    var body = await request.json();
    var workId = body.workId;
    var name = body.name;

    // 验证
    if (!workId || !name) {
      return jsonResponse({ error: '缺少参数' }, 400);
    }
    if (!/^w(3[2-9]|[4-5][0-9])$/.test(workId)) {
      return jsonResponse({ error: '无效的作品 ID' }, 400);
    }
    name = String(name).trim();
    if (name.length === 0 || name.length > 20) {
      return jsonResponse({ error: '名字长度需在 1-20 字之间' }, 400);
    }

    // 检查是否已锁定（已确定名字）
    var adoptedKey = 'naming:adopted:' + workId;
    var adoptedData = await env[KV_NAMESPACE].get(adoptedKey);
    if (adoptedData) {
      return jsonResponse({ error: '该作品已确定名字，不再接受提交' }, 403);
    }

    // 基于 IP + workId 去重
    var clientIP = request.headers.get('cf-connecting-ip') || 'unknown';
    var namedKey = 'named:' + clientIP + ':' + workId;

    var alreadyNamed = await env[KV_NAMESPACE].get(namedKey);
    if (alreadyNamed) {
      return jsonResponse({ error: '你已为这张作品取过名字', alreadyNamed: true }, 403);
    }

    // 记录已取名
    await env[KV_NAMESPACE].put(namedKey, name);

    // 追加名字到该作品的名字列表
    var namesKey = 'naming:names:' + workId;
    var namesStr = await env[KV_NAMESPACE].get(namesKey);
    var names = namesStr ? JSON.parse(namesStr) : [];
    names.push(name);
    await env[KV_NAMESPACE].put(namesKey, JSON.stringify(names));

    return jsonResponse({ success: true, nameCount: names.length });
  } catch (err) {
    return jsonResponse({ error: '服务器错误: ' + err.message }, 500);
  }
}

async function handleGetNames(request, env) {
  try {
    var workIds = [];
    for (var num = 32; num <= 56; num++) {
      workIds.push('w' + num);
    }

    var works = {};

    await Promise.all(workIds.map(async function(id) {
      // 获取该作品所有名字
      var namesStr = await env[KV_NAMESPACE].get('naming:names:' + id);
      var names = namesStr ? JSON.parse(namesStr) : [];

      // 获取已采用名字（锁定状态）
      var adoptedStr = await env[KV_NAMESPACE].get('naming:adopted:' + id);
      var adopted = adoptedStr ? JSON.parse(adoptedStr) : null;

      works[id] = {
        names: names,
        adopted: adopted,
        locked: !!adopted
      };
    }));

    return jsonResponse({ success: true, works: works });
  } catch (err) {
    return jsonResponse({ error: '服务器错误: ' + err.message }, 500);
  }
}

// ===== 路由 =====

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    var url = new URL(request.url);
    var path = url.pathname;

    // 投票
    if (path === '/api/vote' && request.method === 'POST') {
      return handleVote(request, env, ctx);
    }
    if (path === '/api/leaderboard' && request.method === 'GET') {
      return handleLeaderboard(request, env);
    }

    // 作品名征集
    if (path === '/api/naming' && request.method === 'POST') {
      return handleNaming(request, env, ctx);
    }
    if (path === '/api/names' && request.method === 'GET') {
      return handleGetNames(request, env);
    }

    return jsonResponse({ error: '未找到' }, 404);
  },
};
