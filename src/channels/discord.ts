import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Find all registered group JIDs that belong to a given Discord channel.
   * Matches both plain JIDs (dc:123) and virtual JIDs (dc:123/agent).
   */
  private findGroupJidsForChannel(channelId: string): string[] {
    const groups = this.opts.registeredGroups();
    const plain = `dc:${channelId}`;
    const virtualPrefix = `dc:${channelId}/`;
    return Object.keys(groups).filter(
      (jid) => jid === plain || jid.startsWith(virtualPrefix),
    );
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Find all registered groups for this channel (plain + virtual JIDs)
      const matchingJids = this.findGroupJidsForChannel(channelId);
      const isMultiAgent = matchingJids.length > 1;

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      // Skip translation for multi-agent channels — each agent has its
      // own trigger (e.g., @Oracle, @Taskmaster) so the global trigger
      // would mis-route.
      if (this.client?.user && !isMultiAgent) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      } else if (this.client?.user && isMultiAgent) {
        // For multi-agent channels, strip <@botId> mentions but don't
        // prepend any trigger — the raw text (e.g., "@Oracle ...") is
        // delivered to all groups and each checks its own trigger.
        const botId = this.client.user.id;
        if (
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`)
        ) {
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery (base JID for channel discovery)
      const baseJid = `dc:${channelId}`;
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        baseJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      if (matchingJids.length === 0) {
        logger.debug(
          { chatJid: baseJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // For virtual JIDs, also store chat metadata so the messages
      // foreign key (chat_jid → chats.jid) is satisfied.
      for (const groupJid of matchingJids) {
        if (groupJid !== baseJid) {
          this.opts.onChatMetadata(
            groupJid,
            timestamp,
            chatName,
            'discord',
            isGroup,
          );
        }
      }

      // Deliver message to all matching groups (plain or virtual JIDs).
      // Each group has its own trigger pattern — the message loop will
      // check triggers per group and only activate the addressed agent.
      for (const groupJid of matchingJids) {
        this.opts.onMessage(groupJid, {
          id: `${msgId}${groupJid === baseJid ? '' : `:${groupJid}`}`,
          chat_jid: groupJid,
          sender,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      }

      logger.info(
        { channelId, chatName, sender: senderName, groupCount: matchingJids.length },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  /**
   * Parse a Discord JID (plain or virtual) into its channel ID and
   * optional agent suffix.
   *   "dc:123"        → { channelId: "123", agent: undefined }
   *   "dc:123/oracle" → { channelId: "123", agent: "oracle" }
   */
  private static parseJid(jid: string): {
    channelId: string;
    agent: string | undefined;
  } {
    const raw = jid.replace(/^dc:/, '');
    const slashIdx = raw.indexOf('/');
    if (slashIdx === -1) return { channelId: raw, agent: undefined };
    return {
      channelId: raw.slice(0, slashIdx),
      agent: raw.slice(slashIdx + 1),
    };
  }

  /**
   * Format an agent name for display: "oracle" → "Oracle"
   */
  private static formatAgentName(agent: string): string {
    // Handle multi-word names separated by hyphens (e.g., "the-watcher" → "The Watcher")
    return agent
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const { channelId, agent } = DiscordChannel.parseJid(jid);
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // For virtual JIDs (multi-agent channels), prefix messages with the
      // agent's name so readers can tell which agent is speaking.
      let finalText = text;
      if (agent) {
        const displayName = DiscordChannel.formatAgentName(agent);
        finalText = `**[${displayName}]**\n${text}`;
      }

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (finalText.length <= MAX_LENGTH) {
        await textChannel.send(finalText);
      } else {
        for (let i = 0; i < finalText.length; i += MAX_LENGTH) {
          await textChannel.send(finalText.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: finalText.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const { channelId } = DiscordChannel.parseJid(jid);
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
