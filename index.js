import { Client, GatewayIntentBits, Events } from 'discord.js'
import { createClient } from '@supabase/supabase-js'

// ── Config ──────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN
const SUPABASE_URL  = process.env.SUPABASE_URL
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY

// IDs des catégories RP à surveiller
const RP_CATEGORY_IDS = [
  '1523840607783616653',
  '1523840634891403274',
  '1523840673395118182',
  '1523840699861307593',
  '1523840728940150986',
  '1523840760670060634',
]
// ────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
})

// ── Bot prêt ────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`)
  await syncAllLocations()
})

// ── Nouveau message dans un salon RP ────────────────────────
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return

  const categoryId = message.channel.parentId
  if (!categoryId || !RP_CATEGORY_IDS.includes(categoryId)) return

  const channelName = message.channel.name
  console.log(`📍 Message de ${message.author.username} dans #${channelName}`)

  // Chercher le lieu correspondant au salon
  const { data: location } = await supabase
    .from('map_locations')
    .select('id, lat, lng')
    .ilike('discord_channel', channelName)
    .maybeSingle()

  if (!location || !location.lat || !location.lng) {
    // Lieu non encore positionné sur la carte — on ignore le déplacement
    console.log(`⚠️  Lieu "${channelName}" pas encore placé sur la carte`)
    return
  }

  // Chercher le profil Supabase lié au compte Discord
  const discordId = message.author.id
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (!profile) {
    console.log(`⚠️  Joueur Discord ${message.author.username} pas encore connecté sur le site`)
    return
  }

  // Déplacer le joueur sur la carte
  const { error } = await supabase
    .from('profiles')
    .update({
      map_lat: location.lat,
      map_lng: location.lng,
    })
    .eq('id', profile.id)

  if (!error) {
    console.log(`✅ ${message.author.username} déplacé vers "${channelName}"`)
  }
})

// ── Sync tous les salons des catégories RP ──────────────────
async function syncAllLocations() {
  for (const guild of client.guilds.cache.values()) {
    const channels = guild.channels.cache.filter(c =>
      c.parentId && RP_CATEGORY_IDS.includes(c.parentId) && c.isTextBased()
    )

    console.log(`🔄 ${channels.size} salons RP trouvés`)

    for (const channel of channels.values()) {
      const channelName = channel.name

      // Vérifier si le lieu existe déjà
      const { data: existing } = await supabase
        .from('map_locations')
        .select('id')
        .ilike('discord_channel', channelName)
        .maybeSingle()

      if (!existing) {
        // Créer le lieu sans coordonnées (à placer par le MJ)
        const { error } = await supabase
          .from('map_locations')
          .insert({
            name:            formatChannelName(channelName),
            discord_channel: channelName,
            description:     channel.topic ?? '',
            icon:            '📍',
            color:           '#b96eff',
            lat:             null,
            lng:             null,
          })

        if (!error) {
          console.log(`✅ Lieu créé : "${formatChannelName(channelName)}"`)
        } else {
          console.error(`❌ Erreur création lieu "${channelName}":`, error.message)
        }
      }
    }
  }
}

// Transforme "quartier-nord" en "Quartier Nord"
function formatChannelName(name) {
  return name
    .replace(/-/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase())
}

client.login(DISCORD_TOKEN)
