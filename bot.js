// bot.js — Magik: Discord bot + Express webhook
const fs = require('fs');
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');

const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const SHARED_SECRET = process.env.SHARED_SECRET || 'super-secret-token';
const MAPPING_FILE = './rbx_to_discord.json';
const CHANNEL_PREFIX = process.env.CHANNEL_PREFIX || 'Magik-'; // updated prefix

if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN or GUILD_ID in env. Exiting.');
  process.exit(1);
}

// load or create mapping file
let mapping = {};
if (fs.existsSync(MAPPING_FILE)) {
  try { mapping = JSON.parse(fs.readFileSync(MAPPING_FILE,'utf8')); } catch(e){ mapping = {} }
}
function saveMapping() { fs.writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2)); }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ]
});

const app = express();
app.use(express.json());

// /link endpoint — accepts Roblox server linking requests
app.post('/link', (req, res) => {
  const { robloxName, discordId, adminKey } = req.body || {};
  if (adminKey !== SHARED_SECRET) return res.status(403).send({ error: 'forbidden' });
  if (!robloxName || !discordId) return res.status(400).send({ error: 'missing' });

  mapping[robloxName] = discordId;
  saveMapping();
  console.log(`Magik: Linked ${robloxName} -> ${discordId}`);
  return res.send({ ok: true });
});

// /updateGroups endpoint — receives clusters from Roblox (only for linked players)
app.post('/updateGroups', async (req, res) => {
  const secret = req.get('X-Shared-Secret') || "";
  if (secret !== SHARED_SECRET) return res.status(403).send({ error: 'forbidden' });

  const body = req.body;
  if (!body || !Array.isArray(body.clusters)) return res.status(400).send({ error: 'bad request' });

  try {
    await handleClusters(body.clusters);
    return res.send({ ok: true });
  } catch (err) {
    console.error('Error handling clusters:', err);
    return res.status(500).send({ error: 'internal' });
  }
});

async function handleClusters(clusters) {
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.members.fetch();

  // fetch existing voice channels with our prefix
  const fetchedChannels = await guild.channels.fetch();
  const existing = fetchedChannels.filter(c => c.name && c.name.startsWith(CHANNEL_PREFIX) && c.type === 2); // 2 voice
  const channelByIndex = {};
  existing.forEach(ch => {
    const match = ch.name.match(new RegExp('^' + CHANNEL_PREFIX + '(\\d+)$'));
    if (match) channelByIndex[parseInt(match[1],10)] = ch;
  });

  // ensure enough channels
  for (let i = 0; i < clusters.length; i++) {
    const idx = i + 1;
    if (!channelByIndex[idx]) {
      const created = await guild.channels.create({
        name: `${CHANNEL_PREFIX}${idx}`,
        type: 2
      });
      channelByIndex[idx] = created;
    }
  }

  // move members that are currently connected
  for (let i = 0; i < clusters.length; i++) {
    const channel = channelByIndex[i + 1];
    const cluster = clusters[i];
    for (const rbxName of cluster) {
      const discordId = mapping[rbxName];
      if (!discordId) {
        console.log(`Magik: No mapping for ${rbxName}`);
        continue;
      }
      try {
        const member = await guild.members.fetch(discordId).catch(()=>null);
        if (!member) {
          console.log(`Magik: No guild member for ${discordId}`);
          continue;
        }
        if (member.voice && member.voice.channelId) {
          await member.voice.setChannel(channel.id, `Magik proximity grouping`);
          console.log(`Magik: Moved ${rbxName} -> ${channel.name}`);
        } else {
          // user not in a voice channel — skip (respect consent)
          console.log(`Magik: ${rbxName} not in VC; skipping`);
        }
      } catch (err) {
        console.warn('Magik: Error moving member', rbxName, err);
      }
    }
  }
}

app.listen(PORT, () => console.log(`Magik HTTP server listening on ${PORT}`));
client.on('ready', () => console.log(`Magik Discord bot ready as ${client.user.tag}`));
client.login(DISCORD_TOKEN);
