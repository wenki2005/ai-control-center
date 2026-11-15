import { mkdirSync } from 'node:fs';
import { gmInstructions, gmPrompt } from './prompts/gm.mjs';
import { redact } from './redact.mjs';

const GM_HELP = 'GM 开启 · 进入或继续\nGM 开场 你的设定 · 开新存档\n直接发台词或行动 · 推进一回合\nGM 撤回 2 · 回退两步（可省略数字）\nGM 修改 3 新内容 · 从第 3 步改写\nGM 修改回复 3 正文 · 直接编辑该步的 GM 回复\nGM 重写 3 · 保留第 3 步的输入，重新生成\nGM 历史 · 查看当前剧情步号和版本号\nGM 分支 · 查看可恢复的版本\nGM 恢复 版本号 · 回到该版本\nGM 存档 / GM 继续 存档号 · 管理存档\nGM 退出 / GM 确认退出 · 回到原聊天';

const commandText = text => String(text ?? '').trim().replace(/^(?:开启|进入)\s*GM(?=\s|$)/iu, 'GM 开启').replace(/^退出\s*GM$/iu, 'GM 退出');
export const isGmCommand = text => /^GM(?:\s|$)/iu.test(commandText(text));
export const isGmDelivery = row => String(row?.dedupe ?? '').startsWith('gm:');

export class GmGame {
  constructor({ store, adapter, cwd, model = 'gpt-6.1-terra', onDelivery = () => {}, timeoutMs = 150000 }) {
    Object.assign(this, { store, db: store.db, adapter, cwd, model, onDelivery, timeoutMs });
    this.db.exec(`CREATE TABLE IF NOT EXISTS gm_state (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, gameId INTEGER, exitUntil INTEGER);
      INSERT OR IGNORE INTO gm_state VALUES(1,0,NULL,NULL);
      CREATE TABLE IF NOT EXISTS gm_games (id INTEGER PRIMARY KEY, head INTEGER, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gm_moves (id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES gm_games(id), messageId TEXT NOT NULL UNIQUE,
        parentId INTEGER REFERENCES gm_moves(id), input TEXT NOT NULL, output TEXT, status TEXT NOT NULL, branch INTEGER NOT NULL DEFAULT 0, step INTEGER);
      CREATE INDEX IF NOT EXISTS gm_game_status ON gm_moves(gameId,status,id);`);
  }

  state() { return this.db.prepare('SELECT enabled,gameId,exitUntil FROM gm_state WHERE id=1').get(); }
  accepts(text) { return isGmCommand(text) || Boolean(this.state().enabled); }
  get busy() { return Boolean(this.flight || (!this.closed && this.db.prepare("SELECT 1 FROM gm_moves WHERE status='queued' LIMIT 1").get())); }

  start() {
    this.store.transaction(() => {
      for (const row of this.db.prepare("SELECT id,gameId FROM gm_moves WHERE status='running'").all()) {
        this.db.prepare("UPDATE gm_moves SET status='interrupted' WHERE id=?").run(row.id);
        this.db.prepare("UPDATE gm_moves SET status='superseded' WHERE gameId=? AND status='queued'").run(row.gameId);
        this.store.enqueue('中枢重开时这回合尚未完成。存档仍在上一版，本轮及排队动作可重新发送。', `gm:interrupted:${row.id}`);
      }
    });
    this.kick();
  }

  newGame() { return Number(this.db.prepare('INSERT INTO gm_games(head,createdAt) VALUES(NULL,?)').run(this.store.now()).lastInsertRowid); }
  game(id) { return this.db.prepare('SELECT id,head FROM gm_games WHERE id=?').get(id); }
  move(id) { return this.db.prepare("SELECT * FROM gm_moves WHERE id=? AND status='completed'").get(id); }
  activate(id) { this.db.prepare('UPDATE gm_state SET enabled=1,gameId=?,exitUntil=NULL WHERE id=1').run(id); }
  recentPath(head, limit) {
    return this.db.prepare(`WITH RECURSIVE path(id,parentId,input,output,step,depth) AS (
      SELECT id,parentId,input,output,step,1 FROM gm_moves WHERE id=? AND status='completed'
      UNION ALL SELECT m.id,m.parentId,m.input,m.output,m.step,p.depth+1 FROM gm_moves m JOIN path p ON m.id=p.parentId WHERE p.depth<?
    ) SELECT id,parentId,input,output,step FROM path ORDER BY depth DESC`).all(head,limit);
  }
  step(head, number) {
    return this.db.prepare(`WITH RECURSIVE path(id,parentId,step) AS (
      SELECT id,parentId,step FROM gm_moves WHERE id=? AND status='completed'
      UNION ALL SELECT m.id,m.parentId,m.step FROM gm_moves m JOIN path p ON m.id=p.parentId WHERE p.step>?
    ) SELECT id FROM path WHERE step=?`).get(head,number,number)?.id;
  }
  invalidate(id) {
    if (!id) return;
    this.db.prepare("UPDATE gm_moves SET status='superseded' WHERE gameId=? AND status IN ('queued','running')").run(id);
    this.db.prepare("UPDATE outbox SET status='suppressed',updatedAt=? WHERE status='pending' AND deliveryGroup LIKE ?").run(this.store.now(),`gm:scene:${id}:%`);
    if (this.liveGame===id) this.abortGeneration?.();
  }
  queue(id, messageId, input, parent) {
    this.db.prepare("INSERT INTO gm_moves(gameId,messageId,parentId,input,status,branch) VALUES(?,?,?,?,'queued',?)").run(id,messageId,parent ?? null,redact(input),Number(parent!==undefined));
  }

  handle(record) {
    if (!this.accepts(record.text)) return false;
    this.store.transaction(() => {
      if (this.db.prepare('SELECT status FROM inbox WHERE messageId=?').get(record.messageId)?.status!=='pending') return;
      const text=commandText(record.text);
      const reply=this.apply(text,record.messageId);
      if (reply) this.store.enqueue(reply,`gm:command:${record.messageId}`);
      this.store.incomingDone(record.messageId);
    });
    this.kick();
    return true;
  }

  apply(text, key) {
    const state=this.state(), game=this.game(state.gameId);
    const command=/^GM(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/iu.exec(text);
    const verb=command?.[1] ?? '', args=command?.[2]?.trim() ?? '';
    if ((command && (!verb || verb==='帮助')) || text==='菜单') return GM_HELP;
    if (verb==='存档') {
      const rows=this.db.prepare('SELECT id,head FROM gm_games ORDER BY id DESC LIMIT 15').all();
      return rows.length?rows.map(row=>`存档 ${row.id}${row.id===state.gameId?'（当前）':''} · ${this.move(row.head)?.step ?? 0} 步`).join('\n'):'还没有 GM 存档。';
    }
    if (verb==='退出') {
      if (!state.enabled) return 'GM 模式未开启。';
      this.db.prepare('UPDATE gm_state SET exitUntil=? WHERE id=1').run(Date.now()+120000);
      return '发送「GM 确认退出」回到原聊天，当前存档会保留。';
    }
    if (verb==='确认退出') {
      if (!state.enabled || !(state.exitUntil>=Date.now())) return '请先发送「GM 退出」。';
      this.invalidate(state.gameId);
      this.db.prepare('UPDATE gm_state SET enabled=0,exitUntil=NULL WHERE id=1').run();
      return '已退出 GM，存档已保留。';
    }
    if (verb==='开启' && !args) {
      this.activate(game?.id ?? this.newGame());
      return game?.head?'已回到当前 GM 存档。直接发下一步行动，或输入「GM 帮助」。':'GM 已开启。把开场设定发过来就能开始。';
    }
    if (verb==='继续') {
      const saved=/^\d+$/u.test(args)?this.game(Number(args)):null;
      if (!saved) return '找不到这个存档，发送「GM 存档」查看编号。';
      if (saved.id!==state.gameId) this.invalidate(state.gameId);
      this.activate(saved.id);
      return `已继续存档 ${saved.id}。`;
    }
    if (verb==='开场' || (verb==='开启' && args)) {
      if (!args || args.length>12000) return '请输入开场设定，最多 12000 字符。';
      this.invalidate(state.gameId);
      const id=this.newGame();this.activate(id);this.queue(id,key,args);
      return '';
    }
    if (!state.enabled || !game) return '先发送「GM 开启」进入游戏。';
    if (verb==='历史') {
      const rows=this.recentPath(game.head,15);
      return rows.length?rows.map(row=>`第 ${row.step} 步 · 版本 ${row.id} · ${row.input.replace(/\s+/gu,' ').slice(0,65)}`).join('\n'):'当前剧情还没有完成的回合。';
    }
    if (verb==='分支') {
      const rows=this.db.prepare("SELECT id,step,input FROM gm_moves WHERE gameId=? AND status='completed' ORDER BY id DESC LIMIT 15").all(game.id);
      return rows.length?rows.map(row=>`版本 ${row.id} · 第 ${row.step} 步${row.id===game.head?'（当前）':''} · ${row.input.replace(/\s+/gu,' ').slice(0,65)}`).join('\n'):'当前存档还没有可恢复的版本。';
    }
    if (verb==='恢复' || verb==='撤回') {
      const count=Number(args || '1'), head=this.move(game.head);
      const saved=verb==='恢复' && /^\d+$/u.test(args)?this.move(count):null;
      if (verb==='恢复' && saved?.gameId!==game.id) return '这个版本不在当前存档，发送「GM 分支」查看版本号。';
      if (verb==='撤回' && (!Number.isSafeInteger(count) || count<1 || count>(head?.step||0) || (args && !/^\d+$/u.test(args)))) {
        if (!head && this.busy && count===1) { this.invalidate(game.id);return '已撤回尚未完成的开场，可以重新发送设定。'; }
        return `当前已完成 ${head?.step||0} 步，请输入有效的回退步数。`;
      }
      const target=saved?.id ?? this.step(game.head,head.step-count) ?? null;
      this.invalidate(game.id);
      this.db.prepare('UPDATE gm_games SET head=? WHERE id=?').run(target,game.id);
      return target?`已切到第 ${this.move(target).step} 步，版本 ${target}。后续行动从这里继续。`:'已回到开场前，可以发新的开场设定。';
    }
    if (verb==='修改' || verb==='重写' || verb==='修改回复') {
      const parts=/^(\d+)(?:\s+([\s\S]+))?$/u.exec(args);
      const row=parts?this.move(this.step(game.head,Number(parts[1])) ?? null):null;
      const input=verb==='重写'?row?.input:parts?.[2];
      if (!row || !input || input.length>12000 || (verb==='重写' && parts?.[2])) return '用「GM 修改 步号 新内容」或「GM 重写 步号」，步号可在「GM 历史」查看。';
      this.invalidate(game.id);
      if (verb==='修改回复') {
        const result=this.db.prepare("INSERT INTO gm_moves(gameId,messageId,parentId,input,output,status,branch,step) VALUES(?,?,?,?,?,'completed',1,?)")
          .run(game.id,key,row.parentId,row.input,redact(input),row.step);
        const version=Number(result.lastInsertRowid);
        this.db.prepare('UPDATE gm_games SET head=? WHERE id=?').run(version,game.id);
        return `已修改第 ${row.step} 步的 GM 回复，版本 ${version}。后续从这版继续，旧版可从「GM 分支」恢复。`;
      }
      this.queue(game.id,key,input,row.parentId);
      return `将从第 ${row.step} 步改写。原剧情可从「GM 分支」恢复。`;
    }
    if (command) return '这个 GM 命令未识别。发送「GM 帮助」查看用法。';
    if (!text || text.length>12000) return '请发送文字设定、行动或台词，单条最多 12000 字符。';
    if (this.db.prepare("SELECT COUNT(*) n FROM gm_moves WHERE gameId=? AND status='queued'").get(game.id).n>=12) return 'GM 待写回合已满，等当前回合结束后再发。';
    this.queue(game.id,key,text);
    return '';
  }

  kick() {
    if (this.closed || this.flight) return;
    const row=this.db.prepare("SELECT * FROM gm_moves WHERE status='queued' ORDER BY id LIMIT 1").get();
    if (!row) return;
    const parent=row.branch?row.parentId:this.game(row.gameId).head;
    const step=(this.move(parent)?.step ?? 0)+1;
    this.db.prepare("UPDATE gm_moves SET parentId=?,step=?,status='running' WHERE id=?").run(parent,step,row.id);
    this.flight=Promise.resolve().then(()=>this.generate(row,parent)).then(output=>this.finish(row,step,output),error=>this.finish(row,step,'',error.message))
      .finally(()=>{this.flight=null;this.kick();});
    void this.flight.catch(()=>{});
  }

  async generate(row, parent) {
    mkdirSync(this.cwd,{recursive:true});
    const history=this.recentPath(parent,1000);
    const prompt=gmPrompt(null,history,row.input);
    if ((history[0] && history[0].step!==1) || prompt.length>90000) throw Error('GM_CONTEXT_LIMIT');
    const task={id:`gm-${row.id}`,role:'gm',displayTitle:'GM · 独立游戏',cwd:this.cwd,model:this.model,prompt,gmInstructions};
    let timeout;
    try {
      return await new Promise((resolve,reject)=>{
        this.liveGame=row.gameId;
        this.abortGeneration=()=>{
          void Promise.resolve(this.adapter.cancel?.(task)).catch(()=>{});
          reject(Error('GM superseded'));
        };
        timeout=setTimeout(()=>{void Promise.resolve(this.adapter.cancel?.(task)).catch(()=>{});reject(Error('GM timeout'));},this.timeoutMs);
        timeout.unref?.();
        Promise.resolve(this.adapter.start(task,event=>{
          if (event.type==='completed') {
            const output=redact(String(event.text||'')).trim();
            if(output.length>6000)reject(Error('GM output too long'));
            else resolve(output);
          }
          else if (event.type==='failed') reject(Error('GM generation failed'));
        })).catch(reject);
      });
    } finally { clearTimeout(timeout);this.abortGeneration=null;this.liveGame=null; }
  }

  finish(row, step, output, error='') {
    if (this.closed) return;
    const changed=this.store.transaction(()=>{
      const active=this.db.prepare("SELECT 1 FROM gm_moves WHERE id=? AND status='running'").get(row.id);
      if (!active) return false;
      if (!output) {
        this.db.prepare("UPDATE gm_moves SET status='failed' WHERE id=?").run(row.id);
        this.db.prepare("UPDATE gm_moves SET status='superseded' WHERE gameId=? AND status='queued'").run(row.gameId);
        this.store.enqueue(error==='GM_CONTEXT_LIMIT'?'当前存档篇幅已到本模式的上下文上限。可用「GM 开场 新设定」另开存档，原存档仍可查看和恢复。':'GM 这回合没写完，剧情停在上一版。请重新发送这一步及后续动作。',`gm:failed:${row.id}`);
        return true;
      }
      this.db.prepare("UPDATE gm_moves SET status='completed',output=? WHERE id=?").run(output,row.id);
      this.db.prepare('UPDATE gm_games SET head=? WHERE id=?').run(row.id,row.gameId);
      const chunks=Array.from(`【GM 第 ${step} 步 · 版本 ${row.id}】\n${output}`);
      for(let start=0;start<chunks.length;start+=850) this.store.enqueue(chunks.slice(start,start+850).join(''),`gm:scene:${row.gameId}:${row.id}:part:${start/850}`);
      return true;
    });
    if (changed) void Promise.resolve().then(this.onDelivery).catch(()=>{});
  }

  close() { this.closed=true;this.abortGeneration?.(); }
}
