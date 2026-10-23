## 实现channel

Channel 这个概念其实顾名思义——就是 Agent 跟外界通信的通道。终端是一个 Channel，飞书群是一个 Channel，Telegram 是一个 Channel，甚至邮件也可以是一个 Channel。

跟 Plugin 一样，Channel 也需要一个接口契约。一个 Channel 要能启动、停止、发消息，还要能把收到的消息通知给 Gateway
src/channels/types.ts
```ts

export interface IncomingMessage {
  channelId: string;
  senderId: string;
  senderName: string;
  text: string;
  raw?: unknown;
}

export interface OutgoingMessage {
  channelId: string;
  recipientId: string;
  text: string;
}

export interface ChannelDefinition {
  name: string;
  description: string;

  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  send(message: OutgoingMessage): Promise<void>;

  onMessage?: (handler: (msg: IncomingMessage) => void) => void;
}

```


### 实现 ChannelGateway
Gateway 是 Channel 系统的中枢——它注册所有 Channel，统一处理消息路由。收到任何 Channel 的消息后，丢给 Agent Loop 处理，拿到回复再通过同一个 Channel 发回去。

新建 src/channels/gateway.ts：

```ts
import type { ModelMessage } from 'ai';
import type { ChannelDefinition, IncomingMessage, OutgoingMessage } from './types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { agentLoop } from '../agent/loop.js';

interface GatewayOptions {
  model: any;
  registry: ToolRegistry;
  buildSystem: () => string;
}

export class ChannelGateway {
  private channels = new Map<string, ChannelDefinition>();
  private sessions = new Map<string, ModelMessage[]>();
  private options: GatewayOptions;

  constructor(options: GatewayOptions) {
    this.options = options;
  }

  register(channel: ChannelDefinition): void {
    this.channels.set(channel.name, channel);

    channel.onMessage?.((msg: IncomingMessage) => {
      this.handleIncoming(channel.name, msg);
    });
  }

  async startAll(): Promise<void> {
    for (const [name, ch] of this.channels) {
      try {
        await ch.start();
        console.log(`  [gateway] ✓ ${name} 已启动`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [gateway] ✗ ${name} 启动失败: ${msg}`);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [, ch] of this.channels) {
      await ch.stop();
    }
  }

  private async handleIncoming(channelName: string, msg: IncomingMessage): Promise<void> {
    const sessionKey = `${channelName}:${msg.senderId}`;
    console.log(`\n  [${channelName}] ${msg.senderName}: ${msg.text}`);

    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, []);
    }
    const messages = this.sessions.get(sessionKey)!;

    const userMsg: ModelMessage = { role: 'user', content: msg.text };
    messages.push(userMsg);

    const system = this.options.buildSystem();
    await agentLoop(this.options.model, this.options.registry, messages, system);

    // 从 messages 里取最后一条 assistant 消息作为回复
    const lastMsg = messages[messages.length - 1];
    let replyText = '';
    if (lastMsg && lastMsg.role === 'assistant') {
      const content = lastMsg.content;
      if (typeof content === 'string') {
        replyText = content;
      } else if (Array.isArray(content)) {
        replyText = content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('');
      }
    }

    if (replyText) {
      const channel = this.channels.get(channelName);
      if (channel) {
        await channel.send({
          channelId: msg.channelId,
          recipientId: msg.senderId,
          text: replyText,
        });
        console.log(`  [${channelName}] → ${replyText.slice(0, 80)}${replyText.length > 80 ? '...' : ''}`);
      }
    }
  }

  list(): Array<{ name: string; description: string }> {
    return Array.from(this.channels.values()).map(ch => ({
      name: ch.name,
      description: ch.description,
    }));
  }
}

```

### 飞书 Bot 适配器
有了抽象层，接飞书就是实现一个 ChannelDefinition。飞书 SDK 提供了长连接模式——你的服务主动连接飞书的 WebSocket 服务器，消息通过长连接推过来，不需要公网域名。比传统的 Webhook 回调模式省事很多。

新建 src/channels/feishu.ts：

```ts
import type { ChannelDefinition, IncomingMessage, OutgoingMessage } from './types.js';

interface FeishuConfig {
  appId: string;
  appSecret: string;
  port: number;
}

export class FeishuChannel implements ChannelDefinition {
  name = 'feishu';
  description = '飞书 Bot 消息通道（长连接模式）';

  private config: FeishuConfig;
  private messageHandler?: (msg: IncomingMessage) => void;
  private httpServer?: any;
  private wsClient?: any;
  private larkClient?: any;

  constructor(config: FeishuConfig) {
    this.config = config;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    // 启动状态面板（不管有没有配飞书都起）
    await this.startDashboard();

    if (!this.config.appId || !this.config.appSecret) {
      console.log('    飞书未配置 APP_ID / APP_SECRET，仅启动 Dashboard');
      console.log('    用页面上的「发送测试消息」或 curl 测试 Channel 流程');
      return;
    }

    // 用飞书 SDK 的长连接模式
    const lark = await import('@larksuiteoapi/node-sdk');

    this.larkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    const dispatcher = new lark.EventDispatcher({});

    dispatcher.register({
      'im.message.receive_v1': (data) => {
        if (data.message.message_type !== 'text') return;

        const content = JSON.parse(data.message.content);
        let text = content.text || '';
        // 去掉 @Bot 的 mention 标记
        if (data.message.mentions) {
          for (const m of data.message.mentions) {
            text = text.replace(m.key, '').trim();
          }
        }

        if (text && this.messageHandler) {
          this.messageHandler({
            channelId: data.message.chat_id,
            senderId: data.sender.sender_id?.open_id || 'unknown',
            senderName: data.sender.sender_id?.open_id || 'unknown',
            text,
            raw: data,
          });
        }
      },
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.WARN,
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    console.log('    飞书长连接已建立（无需 ngrok）');
  }

  async stop(): Promise<void> {
    if (this.httpServer) this.httpServer.close();
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.larkClient) {
      console.log(`    [feishu] 未配置飞书，跳过发送: ${message.text.slice(0, 50)}`);
      return;
    }

    try {
      await this.larkClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: message.channelId,
          msg_type: 'text',
          content: JSON.stringify({ text: message.text }),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    [feishu] 发送失败: ${msg}`);
    }
  }

  private async startDashboard(): Promise<void> {
    const { Hono } = await import('hono');
    const { serve } = await import('@hono/node-server');

    const app = new Hono();

    // 模拟 webhook（Dashboard 测试用）
    app.post('/webhook/feishu', async (c) => {
      const body = await c.req.json();

      if (body.header?.event_type === 'im.message.receive_v1') {
        const event = body.event;
        if (event.message?.message_type === 'text') {
          const content = JSON.parse(event.message.content);
          const text = content.text?.replace(/@_user_\d+/g, '').trim();
          if (text && this.messageHandler) {
            this.messageHandler({
              channelId: event.message.chat_id || 'web-test',
              senderId: event.sender?.sender_id?.open_id || 'web-dashboard',
              senderName: event.sender?.sender_id?.open_id || 'web-dashboard',
              text,
              raw: body,
            });
          }
        }
      }

      return c.json({ code: 0 });
    });

    // 状态面板
    app.get('/', (c) => {
      const feishuStatus = this.config.appId ? '已连接（长连接模式）' : '未配置';
      const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <title>Super Agent — Channel Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; min-height: 100vh; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .subtitle { color: #94a3b8; margin-bottom: 2rem; }
    .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
    .card h2 { font-size: 1rem; color: #38bdf8; margin-bottom: 0.75rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
    .badge-ok { background: #065f46; color: #6ee7b7; }
    .badge-off { background: #78350f; color: #fcd34d; }
    .endpoint { font-family: monospace; background: #334155; padding: 4px 8px; border-radius: 4px; font-size: 0.85rem; }
    ul { list-style: none; }
    li { margin-bottom: 0.5rem; }
    textarea { width: 100%; background: #334155; border: 1px solid #475569; color: #e2e8f0; border-radius: 6px; padding: 0.75rem; font-family: monospace; font-size: 0.85rem; resize: vertical; min-height: 60px; }
    button { background: #2563eb; color: white; border: none; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; margin-top: 0.5rem; font-size: 0.9rem; }
    button:hover { background: #1d4ed8; }
    #result { margin-top: 0.75rem; padding: 0.75rem; background: #334155; border-radius: 6px; font-family: monospace; font-size: 0.8rem; white-space: pre-wrap; display: none; }
  </style>
</head>
<body>
  <h1>Super Agent v0.16</h1>
  <p class="subtitle">Channel Dashboard</p>

  <div class="card">
    <h2>Channel 状态</h2>
    <ul>
      <li><span class="badge ${this.config.appId ? 'badge-ok' : 'badge-off'}">${feishuStatus}</span> feishu — 飞书 Bot 消息通道</li>
    </ul>
  </div>

  <div class="card">
    <h2>发送测试消息</h2>
    <p style="color: #94a3b8; font-size: 0.85rem; margin-bottom: 0.75rem;">通过模拟 webhook 发消息给 Agent，回复在终端查看</p>
    <textarea id="msg" placeholder="输入要发给 Agent 的消息...">你好</textarea>
    <button onclick="sendTest()">发送</button>
    <div id="result"></div>
  </div>

  <script>
    async function sendTest() {
      const text = document.getElementById('msg').value.trim();
      if (!text) return;
      const result = document.getElementById('result');
      result.style.display = 'block';
      result.textContent = '发送中...';
      try {
        const body = {
          header: { event_type: 'im.message.receive_v1' },
          event: {
            message: { message_type: 'text', content: JSON.stringify({ text }), chat_id: 'web-test' },
            sender: { sender_id: { open_id: 'web-dashboard' } }
          }
        };
        const res = await fetch('/webhook/feishu', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        result.textContent = 'OK — 查看终端输出';
      } catch (e) {
        result.textContent = e.message;
      }
    }
  </script>
</body>
</html>`;
      return c.html(html);
    });

    app.get('/health', (c) => c.text('OK'));

    this.httpServer = serve({ fetch: app.fetch, port: this.config.port });
    console.log(`    Dashboard: http://localhost:${this.config.port}`);
  }
}
```

### 后台查询channel
Channel 也需要一个快捷命令来查看当前注册了哪些通道。

```ts
import type { CommandHandler } from './index.js';
import type { ChannelGateway } from '../channels/gateway.js';

export function createChannelCommands(gateway: ChannelGateway): CommandHandler[] {
  return [
    (cmd, _ctx) => {
      if (cmd !== '/channel' && cmd !== '/channel list') return false;

      const channels = gateway.list();
      if (channels.length === 0) {
        console.log('\n[channels] 没有注册的通道。\n');
        return true;
      }

      console.log('\n[channels]');
      for (const ch of channels) {
        console.log(`  ${ch.name} — ${ch.description}`);
      }
      console.log('');
      return true;
    },
  ];
}

```

## 接入主流程

参考

```ts
// 在 import 区域新增：
import { ChannelGateway } from './channels/gateway.js';
import { FeishuChannel } from './channels/feishu.js';
import { createChannelCommands } from './commands/channel.js';

// ── Channel Gateway ────────────────────────────────
const gateway = new ChannelGateway({
  model,
  registry,
  buildSystem: () => builder.build(makePromptCtx()),
});

const FEISHU_PORT = Number(process.env.FEISHU_PORT || '3000');
const feishuChannel = new FeishuChannel({
  appId: process.env.FEISHU_APP_ID || '',
  appSecret: process.env.FEISHU_APP_SECRET || '',
  port: FEISHU_PORT,
});
gateway.register(feishuChannel);

// Commands 里注册 channel 命令
const dispatch = createDispatcher([
  ...debugCommands,
  ...contextCommands,
  ...memoryCommands,
  ...ragCommands,
  ...dreamCommands,
  ...createSkillCommands(skillLoader, activeSkills),
  ...createPluginCommands(pluginManager, availablePlugins),
  ...createChannelCommands(gateway),  // ← 新增
]);

// main() 里启动 Channel
console.log('  启动 Channel...');
await gateway.startAll();

// 退出时 Graceful Shutdown
if (!trimmed || trimmed === 'exit') {
  console.log('Bye!');
  await gateway.stopAll();      // ← 新增：关闭所有 Channel
  await pluginManager.unloadAll();
  rl.close();
  return;
}

```
