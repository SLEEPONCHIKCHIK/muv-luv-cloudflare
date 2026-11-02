const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-Id"
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...cors } });
const now = () => Math.floor(Date.now() / 1000);

async function authenticate(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) throw Object.assign(new Error("AUTH_REQUIRED"), { status: 401 });
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: token })
  });
  const data = await response.json();
  if (!response.ok || !Array.isArray(data.users) || data.users.length !== 1) throw Object.assign(new Error("FIREBASE_AUTH_INVALID"), { status: 401 });
  const u = data.users[0];
  await env.DB.prepare(`INSERT INTO players(uid,email,is_anonymous,created_at,updated_at,last_seen_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET email=excluded.email,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at`)
    .bind(u.localId, u.email || null, u.email ? 0 : 1, now(), now(), now()).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO player_profiles(uid,updated_at) VALUES(?,?)`).bind(u.localId, now()).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO player_saves(uid,updated_at) VALUES(?,?)`).bind(u.localId, now()).run();
  return { uid: u.localId, email: u.email || "", anonymous: !u.email };
}
async function bodyJson(request) {
  try { const b = await request.json(); if (!b || typeof b !== "object" || Array.isArray(b)) throw 0; return b; }
  catch (_) { throw Object.assign(new Error("INVALID_JSON"), { status: 400 }); }
}
async function handle(request, env, user, url) {
  const path = url.pathname;
  // Compatibility with the game's existing {profile, save} cloud snapshot.
  // Access is scoped to the UID obtained from the verified Firebase ID token.
  if (path === "/v1/player/data" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT data_json,revision,updated_at FROM player_documents WHERE uid=?").bind(user.uid).first();
    return json({ ok: true, found: !!row, data: row ? JSON.parse(row.data_json) : null, revision: row?.revision || 0, updated_at: row?.updated_at || 0 });
  }
  if (path === "/v1/player/data" && request.method === "PUT") {
    const b = await bodyJson(request);
    if (!b.data || typeof b.data !== "object" || Array.isArray(b.data)) return json({ error: "PLAYER_DATA_OBJECT_REQUIRED" }, 400);
    const raw = JSON.stringify(b.data);
    if (raw.length > 1000000) return json({ error: "PLAYER_DATA_TOO_LARGE" }, 413);
    // Optimistic concurrency: every client must send the revision it last read.
    // expected_revision=0 is allowed only for the first insert; stale clients
    // receive 409 and cannot overwrite a newer snapshot.
    const expectedRevision = Number(b.expected_revision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return json({ error: "EXPECTED_REVISION_REQUIRED" }, 428);
    }
    const stamp = now();
    const write = await env.DB.prepare(`INSERT INTO player_documents(uid,data_json,revision,updated_at)
      VALUES(?,?,1,?)
      ON CONFLICT(uid) DO UPDATE SET data_json=excluded.data_json,
        revision=player_documents.revision+1,updated_at=excluded.updated_at
      WHERE player_documents.revision = ?`)
      .bind(user.uid, raw, stamp, expectedRevision).run();
    if (Number(write.meta?.changes || 0) !== 1) {
      const current = await env.DB.prepare("SELECT revision,updated_at FROM player_documents WHERE uid=?").bind(user.uid).first();
      return json({ error: "REVISION_CONFLICT", current_revision: Number(current?.revision || 0), current_updated_at: Number(current?.updated_at || 0) }, 409);
    }
    const profile = b.data.profile && typeof b.data.profile === "object" ? b.data.profile : {};
    const save = b.data.save && typeof b.data.save === "object" ? b.data.save : {};
    const profilePublic = JSON.stringify({ account_id: profile.account_id || "", registered_at_unix: Number(profile.registered_at_unix || 0) });
    await env.DB.prepare(`INSERT INTO player_profiles(uid,friend_code,display_name,account_level,public_json,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET
      friend_code=COALESCE(NULLIF(excluded.friend_code,''),player_profiles.friend_code),
      display_name=excluded.display_name,account_level=excluded.account_level,public_json=json_patch(player_profiles.public_json,excluded.public_json),updated_at=excluded.updated_at`)
      .bind(user.uid, String(profile.friend_code || ""), String(profile.display_name || "Командир").slice(0,28), Math.max(1, Number(profile.account_level || 1)), profilePublic, stamp).run();
    if (Object.keys(save).length > 0) {
      await env.DB.prepare(`INSERT INTO player_saves(uid,save_json,revision,updated_at) VALUES(?,?,1,?)
        ON CONFLICT(uid) DO UPDATE SET save_json=excluded.save_json,revision=player_saves.revision+1,updated_at=excluded.updated_at`)
        .bind(user.uid, JSON.stringify(save), stamp).run();
    }
    const saved = await env.DB.prepare("SELECT revision FROM player_documents WHERE uid=?").bind(user.uid).first();
    return json({ ok: true, revision: Number(saved?.revision || 1), updated_at: stamp });
  }

  if (path === "/v1/arena/leaderboard" && request.method === "GET") {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 100)));
    const season = Math.max(1, Number(url.searchParams.get("season") || 1));
    const rows = await env.DB.prepare(`SELECT p.uid,
        COALESCE(NULLIF(pp.display_name,''),'Командир') AS display_name,
        COALESCE(pp.friend_code,'') AS friend_code,
        COALESCE(pp.account_level,1) AS level,
        COALESCE(CAST(json_extract(d.data_json,'$.save.sections.player.arena_points') AS INTEGER),0) AS arena_points,
        COALESCE(CAST(json_extract(d.data_json,'$.save.sections.player.arena_wins') AS INTEGER),0) AS arena_wins,
        COALESCE(CAST(json_extract(d.data_json,'$.save.sections.player.arena_losses') AS INTEGER),0) AS arena_losses,
        COALESCE(CAST(json_extract(d.data_json,'$.save.sections.player.arena_season') AS INTEGER),1) AS arena_season,
        COALESCE(CAST(json_extract(d.data_json,'$.save.sections.player.avatar_index') AS INTEGER),0) AS avatar,
        COALESCE(CAST(json_extract(d.data_json,'$.save.sections.player.avatar_kind') AS TEXT),'char') AS avatar_kind,
        COALESCE(CAST(json_extract(d.data_json,'$.save.sections.player.level') AS INTEGER),pp.account_level,1) AS account_level
      FROM player_documents d
      JOIN players p ON p.uid=d.uid
      LEFT JOIN player_profiles pp ON pp.uid=p.uid
      WHERE COALESCE(CAST(json_extract(d.data_json,'$.save.sections.player.arena_season') AS INTEGER),1)=?
      ORDER BY arena_points DESC, arena_wins DESC, p.uid ASC LIMIT ?`).bind(season, limit).all();
    const players = {};
    for (const row of rows.results || []) {
      const points = Math.max(0, Number(row.arena_points || 0));
      players[row.uid] = {
        uid: row.uid, display_name: row.display_name, friend_code: row.friend_code,
        level: Number(row.level || row.account_level || 1), arena_points: points,
        arena_participated: points > 0 || Number(row.arena_wins || 0) > 0 || Number(row.arena_losses || 0) > 0,
        arena_wins: Number(row.arena_wins || 0), arena_losses: Number(row.arena_losses || 0),
        avatar: Number(row.avatar || 0), avatar_kind: row.avatar_kind || "char",
        commander_bm: Math.max(100, Number(row.account_level || 1) * 150)
      };
    }
    return json({ ok: true, season, players });
  }

  // Public player directory and profile API (Cloudflare D1; Firebase is auth only).
  if (path === "/v1/player/profile" && request.method === "GET") {
    const code = String(url.searchParams.get("friend_code") || "").trim().toUpperCase();
    if (!code || code.length > 32) return json({ error: "INVALID_FRIEND_CODE" }, 400);
    const row = await env.DB.prepare(`SELECT uid,friend_code,display_name,account_level,avatar,public_json,updated_at
      FROM player_profiles WHERE friend_code=? COLLATE NOCASE LIMIT 1`).bind(code).first();
    if (!row) return json({});
    let profile = {};
    try { profile = JSON.parse(row.public_json || "{}"); } catch (_) {}
    return json({ ...profile, uid: row.uid, friend_code: row.friend_code || code,
      display_name: row.display_name || "Командир", level: Number(row.account_level || 1),
      avatar: Number(row.avatar || 0), updated_at_unix: Number(row.updated_at || 0) });
  }
  if (path === "/v1/player/profile" && request.method === "PUT") {
    const b = await bodyJson(request);
    const p = b.profile && typeof b.profile === "object" && !Array.isArray(b.profile) ? b.profile : null;
    if (!p) return json({ error: "PROFILE_OBJECT_REQUIRED" }, 400);
    const friendCode = String(p.friend_code || "").trim().toUpperCase();
    if (!/^[A-Z0-9-]{4,32}$/.test(friendCode)) return json({ error: "INVALID_FRIEND_CODE" }, 400);
    const owner = await env.DB.prepare("SELECT uid FROM player_profiles WHERE friend_code=? COLLATE NOCASE LIMIT 1").bind(friendCode).first();
    if (owner && owner.uid !== user.uid) return json({ error: "FRIEND_CODE_TAKEN" }, 409);
    const display = String(p.display_name || "Командир").trim().slice(0, 28) || "Командир";
    const level = Math.max(1, Math.min(99999, Number(p.level || p.account_level || 1) || 1));
    const avatar = String(p.avatar ?? 0).slice(0, 256);
    const stamp = now();
    const publicProfile = { ...p, uid: user.uid, friend_code: friendCode, display_name: display,
      level, avatar: Number(p.avatar || 0), avatar_kind: String(p.avatar_kind || "char"),
      last_seen_unix: Math.min(stamp, Math.max(0, Number(p.last_seen_unix || stamp))),
      online: Boolean(p.online), updated_at_unix: stamp };
    const publicJson = JSON.stringify(publicProfile);
    if (publicJson.length > 30000) return json({ error: "PUBLIC_PROFILE_TOO_LARGE" }, 413);
    const updatedAt = stamp;
    const result = await env.DB.prepare(`UPDATE player_profiles SET friend_code=?,display_name=?,account_level=?,avatar=?,public_json=?,updated_at=? WHERE uid=?`)
      .bind(friendCode, display, level, avatar, publicJson, updatedAt, user.uid).run();
    if (!result.meta?.changes) {
      await env.DB.prepare(`INSERT INTO player_profiles(uid,friend_code,display_name,account_level,avatar,public_json,updated_at)
        VALUES(?,?,?,?,?,?,?)`).bind(user.uid, friendCode, display, level, avatar, publicJson, updatedAt).run();
    }
    return json({ ok: true, profile: publicProfile });
  }
  if (path === "/v1/players" && request.method === "GET") {
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 500)));
    const rows = await env.DB.prepare(`SELECT uid,friend_code,display_name,account_level,avatar,public_json,updated_at
      FROM player_profiles WHERE friend_code IS NOT NULL AND friend_code<>''
      ORDER BY updated_at DESC LIMIT ?`).bind(limit).all();
    const directory = {};
    for (const row of rows.results || []) {
      let profile = {};
      try { profile = JSON.parse(row.public_json || "{}"); } catch (_) {}
      const code = String(row.friend_code || "");
      if (!code) continue;
      directory[code] = { ...profile, uid: row.uid, friend_code: code,
        display_name: row.display_name || "Командир", level: Number(row.account_level || 1),
        avatar: Number(row.avatar || 0), updated_at_unix: Number(row.updated_at || 0) };
    }
    return json(directory);
  }

  if (path === "/v1/me" && request.method === "GET") {
    const [profile, save] = await Promise.all([
      env.DB.prepare("SELECT * FROM player_profiles WHERE uid=?").bind(user.uid).first(),
      env.DB.prepare("SELECT save_json,revision,updated_at FROM player_saves WHERE uid=?").bind(user.uid).first()
    ]);
    return json({ ok: true, user, profile, save: save ? { ...save, data: JSON.parse(save.save_json) } : null });
  }
  if (path === "/v1/player/save" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT save_json,revision,updated_at FROM player_saves WHERE uid=?").bind(user.uid).first();
    return json({ ok: true, save: row ? JSON.parse(row.save_json) : {}, revision: row?.revision || 0, updated_at: row?.updated_at || 0 });
  }
  if (path === "/v1/player/save" && request.method === "PUT") {
    const b = await bodyJson(request);
    if (!b.save || typeof b.save !== "object" || Array.isArray(b.save)) return json({ error: "SAVE_OBJECT_REQUIRED" }, 400);
    const raw = JSON.stringify(b.save);
    if (raw.length > 500000) return json({ error: "SAVE_TOO_LARGE" }, 413);
    const result = await env.DB.prepare(`UPDATE player_saves SET save_json=?,revision=revision+1,updated_at=? WHERE uid=?`)
      .bind(raw, now(), user.uid).run();
    return json({ ok: true, revision: result.meta?.changes ? (await env.DB.prepare("SELECT revision FROM player_saves WHERE uid=?").bind(user.uid).first()).revision : null });
  }
  if (path === "/v1/player/profile" && request.method === "PUT") {
    const b = await bodyJson(request);
    const display = String(b.display_name || "Командир").trim().slice(0, 28) || "Командир";
    const avatar = String(b.avatar || "").slice(0, 256);
    const pub = JSON.stringify(b.public_data && typeof b.public_data === "object" ? b.public_data : {});
    await env.DB.prepare("UPDATE player_profiles SET display_name=?,avatar=?,public_json=?,updated_at=? WHERE uid=?")
      .bind(display, avatar, pub, now(), user.uid).run();
    return json({ ok: true });
  }
  if (path === "/v1/device-token" && request.method === "POST") {
    const b = await bodyJson(request);
    const deviceId = String(b.device_id || "").slice(0, 100), token = String(b.token || "");
    if (!deviceId || token.length < 20 || token.length > 4096) return json({ error: "INVALID_DEVICE_TOKEN" }, 400);
    await env.DB.prepare(`INSERT INTO device_tokens(uid,device_id,token,platform,updated_at) VALUES(?,?,?,'android',?)
      ON CONFLICT(uid,device_id) DO UPDATE SET token=excluded.token,platform='android',updated_at=excluded.updated_at`)
      .bind(user.uid, deviceId, token, now()).run();
    return json({ ok: true });
  }
  if (path === "/v1/device-token" && request.method === "DELETE") {
    const deviceId = url.searchParams.get("device_id") || "";
    await env.DB.prepare("DELETE FROM device_tokens WHERE uid=? AND device_id=?").bind(user.uid, deviceId).run();
    return json({ ok: true });
  }
  if (path === "/v1/world-chat" && request.method === "GET") {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
    const rows = await env.DB.prepare("SELECT message_id,from_uid,text,display_name,sent_at FROM chat_messages WHERE chat_type='world' AND room_id='global' ORDER BY sent_at DESC LIMIT ?").bind(limit).all();
    return json({ ok: true, messages: (rows.results || []).reverse() });
  }
  if (path === "/v1/world-chat" && request.method === "POST") {
    const b = await bodyJson(request), text = String(b.text || "").trim();
    if (!text || text.length > 280) return json({ error: "INVALID_MESSAGE" }, 400);
    const messageId = crypto.randomUUID().replaceAll("-", "");
    const profile = await env.DB.prepare("SELECT display_name FROM player_profiles WHERE uid=?").bind(user.uid).first();
    await env.DB.prepare("INSERT INTO chat_messages(message_id,chat_type,room_id,from_uid,text,display_name,sent_at) VALUES(?,'world','global',?,?,?,?)")
      .bind(messageId, user.uid, text, profile?.display_name || "Командир", now()).run();
    return json({ ok: true, message_id: messageId });
  }
  // Unified D1 social + alliance API. Every UID is taken from verified auth.
  if (path === "/v1/social" && request.method === "POST") {
    const b = await bodyJson(request), action = String(b.action || "");
    const stamp = now();
    const profile = await env.DB.prepare("SELECT display_name,friend_code,account_level FROM player_profiles WHERE uid=?").bind(user.uid).first();
    const member = await env.DB.prepare("SELECT alliance_id,role FROM alliance_members WHERE uid=?").bind(user.uid).first();
    const getAlliance = async (id) => env.DB.prepare("SELECT * FROM alliances WHERE alliance_id=?").bind(id).first();
    const membersObject = async (id) => {
      const q = await env.DB.prepare(`SELECT m.uid,m.role,m.joined_at,p.display_name,p.friend_code,p.account_level
        FROM alliance_members m LEFT JOIN player_profiles p ON p.uid=m.uid WHERE m.alliance_id=? ORDER BY m.joined_at`).bind(id).all();
      const out = {}; for (const x of q.results || []) out[x.uid] = {uid:x.uid,role:x.role,joined_at:x.joined_at,display_name:x.display_name||"Командир",friend_code:x.friend_code||"",level:Number(x.account_level||1)}; return out;
    };
    const snapshot = async () => {
      const m = await env.DB.prepare("SELECT alliance_id,role,joined_at FROM alliance_members WHERE uid=?").bind(user.uid).first();
      if (!m) return {membership:{},alliance:{},join_requests:{},invitations:{}};
      const a = await getAlliance(m.alliance_id); if (!a) return {membership:{},alliance:{},join_requests:{},invitations:{}};
      const [members,req,inv,treasury] = await Promise.all([
        membersObject(m.alliance_id),
        env.DB.prepare(`SELECT r.uid,p.display_name,p.friend_code,p.account_level FROM alliance_join_requests r LEFT JOIN player_profiles p ON p.uid=r.uid WHERE r.alliance_id=?`).bind(m.alliance_id).all(),
        env.DB.prepare(`SELECT i.alliance_id,a.name,a.description FROM alliance_invitations i JOIN alliances a ON a.alliance_id=i.alliance_id WHERE i.uid=?`).bind(user.uid).all(),
        env.DB.prepare("SELECT crystals,credits FROM alliance_treasury WHERE alliance_id=?").bind(m.alliance_id).first()
      ]);
      const requests={}; for(const x of req.results||[]) requests[x.uid]={uid:x.uid,display_name:x.display_name||"Командир",friend_code:x.friend_code||"",level:Number(x.account_level||1)};
      const invitations={}; for(const x of inv.results||[]) invitations[x.alliance_id]={alliance_id:x.alliance_id,alliance_name:x.name,description:x.description,emblem:"⚔"};
      return {membership:{alliance_id:m.alliance_id,role:m.role,joined_at:m.joined_at},alliance:{id:a.alliance_id,name:a.name,description:a.description,leader_uid:a.leader_uid,level:a.level,xp:a.xp,capacity:a.capacity,members},join_requests:requests,invitations,treasury:treasury||{crystals:0,credits:0}};
    };
    if (action === "friend_list" || action === "friend_requests_in" || action === "friend_requests_out") {
      let sql = "";
      if(action==="friend_list") sql=`SELECT f.friend_uid AS uid,p.display_name,p.friend_code,p.account_level,f.created_at FROM friends f LEFT JOIN player_profiles p ON p.uid=f.friend_uid WHERE f.uid=?`;
      if(action==="friend_requests_in") sql=`SELECT r.from_uid AS uid,p.display_name,p.friend_code,p.account_level,r.created_at,r.status FROM friend_requests r LEFT JOIN player_profiles p ON p.uid=r.from_uid WHERE r.to_uid=? AND r.status='pending'`;
      if(action==="friend_requests_out") sql=`SELECT r.to_uid AS uid,p.display_name,p.friend_code,p.account_level,r.created_at,r.status FROM friend_requests r LEFT JOIN player_profiles p ON p.uid=r.to_uid WHERE r.from_uid=? AND r.status='pending'`;
      const q=await env.DB.prepare(sql).bind(user.uid).all(), out={}; for(const x of q.results||[]) out[x.uid]={uid:x.uid,from_uid:action==="friend_requests_in"?x.uid:user.uid,to_uid:action==="friend_requests_in"?user.uid:x.uid,display_name:x.display_name||"Командир",friend_code:x.friend_code||"",level:Number(x.account_level||1),created_at:x.created_at,created_at_unix:x.created_at,status:x.status||"accepted"}; return json(out);
    }
    if (action === "friend_send") {
      const target=String(b.target_uid||""); if(!target||target===user.uid) return json({error:"INVALID_TARGET"},400);
      const exists=await env.DB.prepare("SELECT uid FROM player_profiles WHERE uid=?").bind(target).first(); if(!exists) return json({error:"PLAYER_NOT_FOUND"},404);
      const already=await env.DB.prepare("SELECT 1 AS ok FROM friends WHERE uid=? AND friend_uid=?").bind(user.uid,target).first(); if(already) return json({error:"ALREADY_FRIENDS"},409);
      const reverse=await env.DB.prepare("SELECT status FROM friend_requests WHERE from_uid=? AND to_uid=?").bind(target,user.uid).first();
      if(reverse?.status==="pending") return json({error:"INCOMING_REQUEST_EXISTS"},409);
      await env.DB.prepare(`INSERT INTO friend_requests(from_uid,to_uid,status,created_at,updated_at) VALUES(?,?,'pending',?,?) ON CONFLICT(from_uid,to_uid) DO UPDATE SET status='pending',updated_at=excluded.updated_at`).bind(user.uid,target,stamp,stamp).run(); return json({ok:true});
    }
    if (action === "friend_respond") {
      const other=String(b.target_uid||""), accept=!!b.accept; const r=await env.DB.prepare("SELECT from_uid,to_uid FROM friend_requests WHERE from_uid=? AND to_uid=? AND status='pending'").bind(other,user.uid).first(); if(!r) return json({error:"REQUEST_NOT_FOUND"},404);
      if(accept){await env.DB.batch([env.DB.prepare("INSERT OR IGNORE INTO friends(uid,friend_uid,created_at) VALUES(?,?,?)").bind(user.uid,other,stamp),env.DB.prepare("INSERT OR IGNORE INTO friends(uid,friend_uid,created_at) VALUES(?,?,?)").bind(other,user.uid,stamp),env.DB.prepare("UPDATE friend_requests SET status='accepted',updated_at=? WHERE from_uid=? AND to_uid=?").bind(stamp,other,user.uid)]);} else await env.DB.prepare("UPDATE friend_requests SET status='declined',updated_at=? WHERE from_uid=? AND to_uid=?").bind(stamp,other,user.uid).run(); return json({ok:true});
    }
    if (action === "friend_confirm_link") { const other=String(b.target_uid||""); const found=await env.DB.prepare("SELECT 1 AS ok FROM friends WHERE uid=? AND friend_uid=?").bind(user.uid,other).first(); if(!found)return json({error:"FRIEND_LINK_NOT_FOUND"},404); return json({ok:true}); }
    if (action === "friend_cancel" || action === "friend_remove") {
      const other=String(b.target_uid||""); if(action==="friend_cancel") await env.DB.prepare("DELETE FROM friend_requests WHERE from_uid=? AND to_uid=? AND status='pending'").bind(user.uid,other).run(); else await env.DB.batch([env.DB.prepare("DELETE FROM friends WHERE uid=? AND friend_uid=?").bind(user.uid,other),env.DB.prepare("DELETE FROM friends WHERE uid=? AND friend_uid=?").bind(other,user.uid)]); return json({ok:true});
    }
    if (action === "world_chat_load" || action === "alliance_chat_load" || action === "private_chat_load") {
      let type="world", room="global"; if(action==="alliance_chat_load"){if(!member)return json({error:"NOT_IN_ALLIANCE"},403);type="alliance";room=member.alliance_id;} if(action==="private_chat_load"){const other=String(b.other_uid||"");if(!other)return json({error:"INVALID_RECIPIENT"},400);type="private";room=[user.uid,other].sort().join(":");}
      const q=await env.DB.prepare("SELECT message_id,from_uid,to_uid,text,display_name,sent_at FROM chat_messages WHERE chat_type=? AND room_id=? ORDER BY sent_at DESC LIMIT 100").bind(type,room).all(); const messages={};for(const x of (q.results||[]).reverse())messages[x.message_id]={...x,sent_at_unix:x.sent_at};return json(messages);
    }
    if (action === "world_chat_send" || action === "private_chat_send" || action === "alliance_chat_send") {
      const text=String(b.text||"").trim(); if(!text||text.length>280)return json({error:"INVALID_MESSAGE"},400);
      let type="world",room="global",to=null; if(action==="alliance_chat_send"){if(!member)return json({error:"NOT_IN_ALLIANCE"},403);type="alliance";room=member.alliance_id;} if(action==="private_chat_send"){to=String(b.other_uid||"");if(!to||to===user.uid)return json({error:"INVALID_RECIPIENT"},400);const isFriend=await env.DB.prepare("SELECT 1 AS ok FROM friends WHERE uid=? AND friend_uid=?").bind(user.uid,to).first();if(!isFriend)return json({error:"NOT_FRIENDS"},403);type="private";room=[user.uid,to].sort().join(":");}
      const id=crypto.randomUUID().replaceAll("-",""); await env.DB.prepare("INSERT INTO chat_messages(message_id,chat_type,room_id,from_uid,to_uid,text,display_name,sent_at) VALUES(?,?,?,?,?,?,?,?)").bind(id,type,room,user.uid,to,text,profile?.display_name||"Командир",stamp).run(); if(to) await env.DB.prepare("INSERT OR IGNORE INTO chat_notifications(recipient_uid,sender_uid,message_id,sent_at) VALUES(?,?,?,?)").bind(to,user.uid,id,stamp).run(); return json({ok:true,message_id:id});
    }
    if (action === "world_chat_latest_load") { const row=await env.DB.prepare("SELECT message_id,from_uid,text,display_name,sent_at AS sent_at_unix FROM chat_messages WHERE chat_type='world' AND room_id='global' ORDER BY sent_at DESC LIMIT 1").first(); return json(row||{}); }
    if (action === "chat_notifications_clear") { const sender=String(b.sender_uid||""); const ids=Array.isArray(b.message_ids)?b.message_ids:[]; for(const mid of ids) await env.DB.prepare("DELETE FROM chat_notifications WHERE recipient_uid=? AND sender_uid=? AND message_id=?").bind(user.uid,sender,String(mid)).run(); return json({ok:true}); }
    if (action === "chat_notifications") {const q=await env.DB.prepare(`SELECT n.sender_uid,n.message_id,n.sent_at,m.text,m.display_name FROM chat_notifications n JOIN chat_messages m ON m.message_id=n.message_id WHERE n.recipient_uid=? ORDER BY n.sent_at DESC LIMIT 200`).bind(user.uid).all();const out={};for(const x of q.results||[]){if(!out[x.sender_uid])out[x.sender_uid]={};out[x.sender_uid][x.message_id]={message_id:x.message_id,text_preview:String(x.text).slice(0,80),display_name:x.display_name,sent_at_unix:x.sent_at};}return json(out);}
    if (action.startsWith("alliance_" ) || action === "me" || action === "search" || action === "profile" || action === "create" || action === "join" || action === "world_boss_status" || action === "world_boss_attack" || action === "chat_load" || action === "chat_send") {
      if(action==="me") return json(await snapshot());
      if(action==="search"){const q=String(b.query||"").trim();const rows=await env.DB.prepare(`SELECT a.alliance_id,a.name,a.description,a.level,a.capacity,a.leader_uid,COUNT(m.uid) AS member_count FROM alliances a LEFT JOIN alliance_members m ON m.alliance_id=a.alliance_id WHERE a.name LIKE ? GROUP BY a.alliance_id ORDER BY member_count DESC LIMIT 50`).bind("%"+q+"%").all();return json({alliances:(rows.results||[]).map(x=>({id:x.alliance_id,name:x.name,description:x.description,level:x.level,capacity:x.capacity,member_count:x.member_count,leader_uid:x.leader_uid}))});}
      if(action==="profile"){const id=String(b.alliance_id||"");const a=await getAlliance(id);return json({alliance:a?{id:a.alliance_id,name:a.name,description:a.description,level:a.level,capacity:a.capacity,members:await membersObject(id)}:{}});}
      if(action==="create"){if(member)return json({error:"ALREADY_IN_ALLIANCE"},409);const name=String(b.name||"").trim().slice(0,24),desc=String(b.description||"").slice(0,240);if(name.length<3)return json({error:"INVALID_NAME"},400);const id=crypto.randomUUID().replaceAll("-","").slice(0,16);try{await env.DB.batch([env.DB.prepare("INSERT INTO alliances(alliance_id,name,name_norm,description,leader_uid,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(id,name,name.toLowerCase(),desc,user.uid,stamp,stamp),env.DB.prepare("INSERT INTO alliance_members(alliance_id,uid,role,joined_at) VALUES(?,?, 'leader',?)").bind(id,user.uid,stamp),env.DB.prepare("INSERT INTO alliance_treasury(alliance_id,updated_at) VALUES(?,?)").bind(id,stamp)]);}catch(e){return json({error:"ALLIANCE_CREATE_FAILED"},409);}return json(await snapshot());}
      if(action==="join"){if(member)return json({error:"ALREADY_IN_ALLIANCE"},409);const id=String(b.alliance_id||"");const a=await getAlliance(id);if(!a)return json({error:"ALLIANCE_NOT_FOUND"},404);if(b.type==="open"){await env.DB.prepare("INSERT INTO alliance_members(alliance_id,uid,role,joined_at) VALUES(?,?,'member',?)").bind(id,user.uid,stamp).run();return json({ok:true});}await env.DB.prepare("INSERT OR REPLACE INTO alliance_join_requests(alliance_id,uid,created_at) VALUES(?,?,?)").bind(id,user.uid,stamp).run();return json({request_sent:true});}
      if(action==="world_boss_status"||action==="world_boss_attack"){let row=await env.DB.prepare("SELECT boss_json FROM world_boss_state WHERE id='global'").first();if(!row){const initial={hp:1000000,max_hp:1000000,level:1,cycle_id:"global"};await env.DB.prepare("INSERT INTO world_boss_state(id,boss_json,updated_at) VALUES('global',?,?)").bind(JSON.stringify(initial),stamp).run();row={boss_json:JSON.stringify(initial)};}let boss=JSON.parse(row.boss_json);let damage=0;if(action.endsWith("attack")){damage=1000+Math.floor(Math.random()*4000);boss.hp=Math.max(0,Number(boss.hp||0)-damage);await env.DB.prepare("UPDATE world_boss_state SET boss_json=?,updated_at=? WHERE id='global'").bind(JSON.stringify(boss),stamp).run();await env.DB.prepare("INSERT INTO boss_contributions(boss_type,scope_id,cycle_id,uid,damage,hits,updated_at) VALUES('world','global','global',?,?,1,?) ON CONFLICT(boss_type,scope_id,cycle_id,uid) DO UPDATE SET damage=damage+excluded.damage,hits=hits+1,updated_at=excluded.updated_at").bind(user.uid,damage,stamp).run();}const mine=await env.DB.prepare("SELECT damage FROM boss_contributions WHERE boss_type='world' AND scope_id='global' AND cycle_id='global' AND uid=?").bind(user.uid).first();return json({boss,my_damage:Number(mine?.damage||0),damage});}
      if(!member)return json({error:"NOT_IN_ALLIANCE"},403);
      const id=member.alliance_id, a=await getAlliance(id), role=member.role, p=b;
      if(action==="alliance_boss_status"||action==="alliance_boss_attack"){let row=await env.DB.prepare("SELECT boss_json FROM alliance_boss_state WHERE alliance_id=?").bind(id).first();if(!row){const initial={hp:500000,max_hp:500000,level:1};await env.DB.prepare("INSERT INTO alliance_boss_state(alliance_id,boss_json,updated_at) VALUES(?,?,?)").bind(id,JSON.stringify(initial),stamp).run();row={boss_json:JSON.stringify(initial)};}let boss=JSON.parse(row.boss_json),damage=0;if(action.endsWith("attack")){damage=1000+Math.floor(Math.random()*4000);boss.hp=Math.max(0,Number(boss.hp||0)-damage);await env.DB.prepare("UPDATE alliance_boss_state SET boss_json=?,updated_at=? WHERE alliance_id=?").bind(JSON.stringify(boss),stamp,id).run();await env.DB.prepare("INSERT INTO boss_contributions(boss_type,scope_id,cycle_id,uid,damage,hits,updated_at) VALUES('alliance',?,?,?, ?,1,?) ON CONFLICT(boss_type,scope_id,cycle_id,uid) DO UPDATE SET damage=damage+excluded.damage,hits=hits+1,updated_at=excluded.updated_at").bind(id,"default",user.uid,damage,stamp).run();}const mine=await env.DB.prepare("SELECT damage FROM boss_contributions WHERE boss_type='alliance' AND scope_id=? AND cycle_id='default' AND uid=?").bind(id,user.uid).first();return json({boss,my_damage:Number(mine?.damage||0),damage});}
      if(action==="chat_load"){const q=await env.DB.prepare("SELECT message_id,from_uid,text,display_name,sent_at AS sent_at_unix FROM alliance_chat_messages WHERE alliance_id=? ORDER BY sent_at DESC LIMIT 100").bind(id).all();const messages={};for(const x of (q.results||[]).reverse())messages[x.message_id]=x;return json({messages});}
      if(action==="chat_send"){const text=String(p.text||"").trim();if(!text||text.length>280)return json({error:"INVALID_MESSAGE"},400);const mid=crypto.randomUUID().replaceAll("-","");await env.DB.prepare("INSERT INTO alliance_chat_messages(message_id,alliance_id,from_uid,text,display_name,sent_at) VALUES(?,?,?,?,?,?)").bind(mid,id,user.uid,text,profile?.display_name||"Командир",stamp).run();return json({ok:true,message_id:mid});}
      if(action==="checkin"){const day=new Date().toISOString().slice(0,10);const res=await env.DB.prepare("INSERT OR IGNORE INTO alliance_checkins(alliance_id,uid,day_key) VALUES(?,?,?)").bind(id,user.uid,day).run();if(!res.meta?.changes)return json({error:"ALREADY_CHECKED_IN"},409);await env.DB.prepare("UPDATE alliances SET xp=xp+10,updated_at=? WHERE alliance_id=?").bind(stamp,id).run();return json({tickets:1,alliance_xp:Number(a.xp||0)+10,level:Number(a.level||1),day_key:day});}
      if(action==="treasury_status"){const t=await env.DB.prepare("SELECT crystals,credits FROM alliance_treasury WHERE alliance_id=?").bind(id).first();return json({treasury:t||{crystals:0,credits:0}});}
      if(action==="treasury_deposit"||action==="treasury_withdraw"){if(!["leader","officer"].includes(role))return json({error:"PERMISSION_DENIED"},403);const currency=String(p.currency||"credits");if(!["credits","crystals"].includes(currency))return json({error:"INVALID_CURRENCY"},400);const amount=Math.floor(Number(p.amount||0));if(amount<1||amount>100000000)return json({error:"INVALID_AMOUNT"},400);if(action==="treasury_withdraw")return json({error:"WITHDRAWAL_REQUIRES_SERVER_WALLET_INTEGRATION"},409);await env.DB.prepare(`UPDATE alliance_treasury SET ${currency}=${currency}+?,updated_at=? WHERE alliance_id=?`).bind(amount,stamp,id).run();await env.DB.prepare("INSERT INTO alliance_treasury_ledger(alliance_id,uid,currency,amount,reason,created_at) VALUES(?,?,?,?,?,?)").bind(id,user.uid,currency,amount,"deposit",stamp).run();const t=await env.DB.prepare("SELECT crystals,credits FROM alliance_treasury WHERE alliance_id=?").bind(id).first();return json({treasury:t});}
      if(action==="respond_request"){if(!["leader","officer"].includes(role))return json({error:"PERMISSION_DENIED"},403);const target=String(p.target_uid||"");if(p.accept){const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM alliance_members WHERE alliance_id=?").bind(id).first();if(Number(count?.n||0)>=Number(a.capacity||10))return json({error:"ALLIANCE_FULL"},409);await env.DB.prepare("INSERT INTO alliance_members(alliance_id,uid,role,joined_at) VALUES(?,?,'member',?)").bind(id,target,stamp).run();}await env.DB.prepare("DELETE FROM alliance_join_requests WHERE alliance_id=? AND uid=?").bind(id,target).run();return json({ok:true});}
      if(action==="invite"){if(!["leader","officer","veteran"].includes(role))return json({error:"PERMISSION_DENIED"},403);const code=String(p.friend_code||"").trim().toUpperCase();const target=await env.DB.prepare("SELECT uid FROM player_profiles WHERE friend_code=? COLLATE NOCASE").bind(code).first();if(!target)return json({error:"PLAYER_NOT_FOUND"},404);await env.DB.prepare("INSERT OR REPLACE INTO alliance_invitations(alliance_id,uid,created_at) VALUES(?,?,?)").bind(id,target.uid,stamp).run();return json({ok:true});}
      if(action==="accept_invite"){const aid=String(p.alliance_id||"");const invite=await env.DB.prepare("SELECT 1 AS ok FROM alliance_invitations WHERE alliance_id=? AND uid=?").bind(aid,user.uid).first();if(!invite)return json({error:"INVITE_NOT_FOUND"},404);const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM alliance_members WHERE alliance_id=?").bind(aid).first();const aa=await getAlliance(aid);if(Number(count?.n||0)>=Number(aa?.capacity||10))return json({error:"ALLIANCE_FULL"},409);await env.DB.batch([env.DB.prepare("INSERT INTO alliance_members(alliance_id,uid,role,joined_at) VALUES(?,?,'member',?)").bind(aid,user.uid,stamp),env.DB.prepare("DELETE FROM alliance_invitations WHERE alliance_id=? AND uid=?").bind(aid,user.uid)]);return json({ok:true});}
      if(action==="set_role"){if(role!=="leader")return json({error:"PERMISSION_DENIED"},403);const target=String(p.target_uid||""),newRole=String(p.role||"");if(!["member","veteran","officer"].includes(newRole))return json({error:"INVALID_ROLE"},400);await env.DB.prepare("UPDATE alliance_members SET role=? WHERE alliance_id=? AND uid=?").bind(newRole,id,target).run();return json({ok:true});}
      if(action==="kick"){if(!["leader","officer"].includes(role))return json({error:"PERMISSION_DENIED"},403);const target=String(p.target_uid||"");await env.DB.prepare("DELETE FROM alliance_members WHERE alliance_id=? AND uid=? AND role<>'leader'").bind(id,target).run();return json({ok:true});}
      if(action==="transfer_leader"){if(role!=="leader")return json({error:"PERMISSION_DENIED"},403);const target=String(p.target_uid||"");await env.DB.batch([env.DB.prepare("UPDATE alliance_members SET role='officer' WHERE alliance_id=? AND uid=?").bind(id,user.uid),env.DB.prepare("UPDATE alliance_members SET role='leader' WHERE alliance_id=? AND uid=?").bind(id,target),env.DB.prepare("UPDATE alliances SET leader_uid=?,updated_at=? WHERE alliance_id=?").bind(target,stamp,id)]);return json({ok:true});}
      if(action==="update_description"){if(!["leader","officer"].includes(role))return json({error:"PERMISSION_DENIED"},403);await env.DB.prepare("UPDATE alliances SET description=?,updated_at=? WHERE alliance_id=?").bind(String(p.description||"").slice(0,240),stamp,id).run();return json({ok:true});}
      if(action==="upgrade_slots"){if(role!=="leader")return json({error:"PERMISSION_DENIED"},403);await env.DB.prepare("UPDATE alliances SET capacity=capacity+2,updated_at=? WHERE alliance_id=?").bind(stamp,id).run();return json({ok:true});}
      if(action==="leave"){if(role==="leader")return json({error:"TRANSFER_LEADERSHIP_FIRST"},409);await env.DB.prepare("DELETE FROM alliance_members WHERE alliance_id=? AND uid=?").bind(id,user.uid).run();return json({ok:true});}
      return json({error:"UNSUPPORTED_SOCIAL_ACTION",action},400);
    }
    return json({error:"UNKNOWN_SOCIAL_ACTION"},400);
  }
  return json({ error: "NOT_FOUND" }, 404);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true, service: "muv-luv-cloudflare-api", database: !!env.DB });
    if (!url.pathname.startsWith("/v1/")) return json({ error: "NOT_FOUND" }, 404);
    try {
      const user = await authenticate(request, env);
      return await handle(request, env, user, url);
    } catch (error) {
      const status = Number(error.status || 500);
      return json({ error: status === 500 ? "INTERNAL_ERROR" : error.message, message: status === 500 ? "Внутренняя ошибка сервера." : error.message }, status);
    }
  }
};
