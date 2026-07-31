import { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } from 'discord.js'
import { createClient } from '@supabase/supabase-js'
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'

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

// Durée de validité d'une confirmation "quel perso tu joues" (7 jours)
const CONFIRM_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000
// ────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Un conteneur serveur n'a AUCUNE police installée par défaut —
// sans ça, tout le texte dessiné sur les images serait invisible.
async function loadFonts() {
  try {
    const res = await fetch('https://raw.githubusercontent.com/google/fonts/main/ofl/oswald/Oswald%5Bwght%5D.ttf')
    const buf = Buffer.from(await res.arrayBuffer())
    GlobalFonts.register(buf, 'Oswald')
    console.log('✅ Police chargée (Oswald)')
  } catch (e) {
    console.error('⚠️  Impossible de charger la police, le texte des images risque d\'être invisible:', e.message)
  }
}
await loadFonts()

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ]
})

// ── Bot prêt ────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`)
  await syncAllLocations()
})

// ── Message reçu (RP move + commande !id) ───────────────────
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return

  // ── Commande "!id" — fonctionne partout (salon, MP) ────────
  if (message.content.trim().toLowerCase() === '!id') {
    await handleIdCommand(message)
    return
  }

  // ── Commande "!fiche" — résumé personnage ───────────────────
  if (message.content.trim().toLowerCase() === '!fiche') {
    await handleFicheCommand(message)
    return
  }

  // ── Déplacement sur la carte selon le salon RP ──────────────
  const categoryId = message.channel.parentId
  if (!categoryId || !RP_CATEGORY_IDS.includes(categoryId)) return

  const channelName = message.channel.name
  const discordId = message.author.id

  const chars = await getCharacters(discordId)
  if (chars.length === 0) {
    console.log(`⚠️  ${message.author.username} pas encore connecté sur le site`)
    return
  }

  const resolved = await resolveCharacter(discordId, chars)

  if (resolved.status === 'ask') {
    await askWhichCharacter(message, chars, 'charselect')
    return
  }

  await moveCharacterToChannel(resolved.characterId, channelName, message.author.username)
})

// ── Réponse aux boutons (déplacement + carte ID) ─────────────
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return

  const discordId = interaction.user.id

  if (interaction.customId.startsWith('charselect_')) {
    const characterId = interaction.customId.replace('charselect_', '')

    await supabase.from('discord_character_confirmations').upsert({
      discord_id: discordId,
      character_id: characterId,
      confirmed_at: new Date().toISOString(),
    })

    const channelName = interaction.channel.name
    await moveCharacterToChannel(characterId, channelName, interaction.user.username)

    await interaction.update({
      content: `✅ Personnage confirmé pour la semaine à venir.`,
      components: [],
    })
    return
  }

  if (interaction.customId.startsWith('idcard_')) {
    const characterId = interaction.customId.replace('idcard_', '')

    await supabase.from('discord_character_confirmations').upsert({
      discord_id: discordId,
      character_id: characterId,
      confirmed_at: new Date().toISOString(),
    })

    await interaction.update({ content: `🪪 Génération de ta carte…`, components: [] })
    await sendIdCard(characterId, interaction.user)
    return
  }

  if (interaction.customId.startsWith('fiche_')) {
    const characterId = interaction.customId.replace('fiche_', '')

    await supabase.from('discord_character_confirmations').upsert({
      discord_id: discordId,
      character_id: characterId,
      confirmed_at: new Date().toISOString(),
    })

    await interaction.update({ content: `🪄 Génération de ta fiche…`, components: [] })
    await sendProfileCard(characterId, interaction.user)
    return
  }
})

// ── Commande !id ──────────────────────────────────────────────
async function handleIdCommand(message) {
  const discordId = message.author.id
  const chars = await getCharacters(discordId)

  if (chars.length === 0) {
    await message.reply(`❌ Tu n'as pas encore de personnage sur le site Phoenix RP.`)
    return
  }

  const resolved = await resolveCharacter(discordId, chars)

  if (resolved.status === 'ask') {
    await askWhichCharacter(message, chars, 'idcard')
    return
  }

  await sendIdCard(resolved.characterId, message.author)
}

// ── Commande !fiche ──────────────────────────────────────────
async function handleFicheCommand(message) {
  const discordId = message.author.id
  const chars = await getCharacters(discordId)

  if (chars.length === 0) {
    await message.reply(`❌ Tu n'as pas encore de personnage sur le site Phoenix RP.`)
    return
  }

  const resolved = await resolveCharacter(discordId, chars)

  if (resolved.status === 'ask') {
    await askWhichCharacter(message, chars, 'fiche')
    return
  }

  await sendProfileCard(resolved.characterId, message.author)
}

// Détermine quel personnage est actuellement joué (confirmation valide, ou auto si un seul)
async function getCharacters(discordId) {
  const { data } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('discord_id', discordId)
  return data ?? []
}

async function resolveCharacter(discordId, chars) {
  const { data: confirmation } = await supabase
    .from('discord_character_confirmations')
    .select('*')
    .eq('discord_id', discordId)
    .maybeSingle()

  const isStale = !confirmation ||
    (Date.now() - new Date(confirmation.confirmed_at).getTime() > CONFIRM_VALIDITY_MS)

  const stillValid = confirmation && chars.some(c => c.id === confirmation.character_id)

  if (!isStale && stillValid) {
    return { status: 'ok', characterId: confirmation.character_id }
  }

  if (chars.length === 1) {
    await supabase.from('discord_character_confirmations').upsert({
      discord_id: discordId,
      character_id: chars[0].id,
      confirmed_at: new Date().toISOString(),
    })
    return { status: 'ok', characterId: chars[0].id }
  }

  return { status: 'ask' }
}

async function askWhichCharacter(message, chars, prefix) {
  const row = new ActionRowBuilder().addComponents(
    chars.slice(0, 5).map(c =>
      new ButtonBuilder()
        .setCustomId(`${prefix}_${c.id}`)
        .setLabel(c.username)
        .setStyle(ButtonStyle.Secondary)
    )
  )
  await message.reply({
    content: `🎭 ${message.author}, quel personnage incarnes-tu ?`,
    components: [row],
  })
}

// ── Déplace un personnage sur le lieu correspondant au salon ─
async function moveCharacterToChannel(characterId, channelName, authorName) {
  const { data: location } = await supabase
    .from('map_locations')
    .select('id, lat, lng')
    .ilike('discord_channel', channelName)
    .maybeSingle()

  if (!location || !location.lat || !location.lng) {
    console.log(`⚠️  Lieu "${channelName}" pas encore placé sur la carte`)
    return
  }

  const { error } = await supabase
    .from('profiles')
    .update({ map_lat: location.lat, map_lng: location.lng })
    .eq('id', characterId)

  if (!error) {
    console.log(`✅ ${authorName} déplacé vers "${channelName}"`)
  }
}

// ── Génère et envoie la carte d'identité en MP ───────────────
async function sendIdCard(characterId, discordUser) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', characterId)
    .maybeSingle()

  if (!profile) {
    await discordUser.send(`❌ Personnage introuvable.`)
    return
  }

  try {
    const buffer = await generateIdCardImage(profile)
    const attachment = new AttachmentBuilder(buffer, { name: 'id-card.png' })
    await discordUser.send({
      content: `🪪 Carte d'identité de **${profile.username}**`,
      files: [attachment],
    })
    console.log(`✅ Carte ID envoyée à ${discordUser.username}`)
  } catch (e) {
    console.error('❌ Erreur envoi carte ID:', e.message)
    try {
      await discordUser.send(`❌ Une erreur est survenue lors de la génération de ta carte.`)
    } catch {}
  }
}

// Dessine une carte d'identité façon Arizona (même esprit que le site)
async function generateIdCardImage(profile) {
  const W = 340, H = 480
  const SCALE = 3 // rendu en haute résolution pour un résultat net sur Discord
  const canvas = createCanvas(W * SCALE, H * SCALE)
  const ctx = canvas.getContext('2d')
  ctx.scale(SCALE, SCALE)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // Fond crème
  roundRect(ctx, 0, 0, W, H, 16)
  ctx.fillStyle = '#f0ede6'
  ctx.fill()

  // ── Header rouge Arizona ──
  const headerGrad = ctx.createLinearGradient(0, 0, W, 0)
  headerGrad.addColorStop(0, '#8B1A1A')
  headerGrad.addColorStop(0.5, '#C0392B')
  headerGrad.addColorStop(1, '#8B1A1A')
  ctx.fillStyle = headerGrad
  ctx.fillRect(0, 0, W, 58)

  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 18px Oswald'
  ctx.fillText('ARIZONA', 54, 28)
  ctx.font = '9px Oswald'
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.fillText('DRIVER LICENSE / ID', 54, 42)

  ctx.font = '8px Oswald'
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.textAlign = 'right'
  ctx.fillText('STATE OF ARIZONA', W - 14, 24)
  ctx.fillText('CITY OF PHOENIX', W - 14, 36)
  ctx.textAlign = 'left'

  // Sceau
  ctx.beginPath()
  ctx.arc(30, 29, 16, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(255,255,255,0.15)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.font = '16px Oswald'
  ctx.fillStyle = '#fff'
  ctx.fillText('🌵', 20, 35)

  // Bande or
  const goldGrad = ctx.createLinearGradient(0, 0, W, 0)
  goldGrad.addColorStop(0, '#C8A040')
  goldGrad.addColorStop(0.5, '#F0C040')
  goldGrad.addColorStop(1, '#C8A040')
  ctx.fillStyle = goldGrad
  ctx.fillRect(0, 58, W, 4)

  // ── Photo ──
  const photoX = 16, photoY = 78, photoW = 96, photoH = 122
  ctx.fillStyle = '#d0ccc4'
  ctx.fillRect(photoX, photoY, photoW, photoH)
  ctx.strokeStyle = '#aaa'
  ctx.lineWidth = 1.5
  ctx.strokeRect(photoX, photoY, photoW, photoH)

  if (profile.avatar_url) {
    try {
      const res = await fetch(profile.avatar_url)
      const buf = Buffer.from(await res.arrayBuffer())
      const img = await loadImage(buf)
      ctx.save()
      ctx.beginPath()
      ctx.rect(photoX, photoY, photoW, photoH)
      ctx.clip()
      ctx.filter = 'grayscale(100%) contrast(1.05)'
      // Cover-fit
      const scale = Math.max(photoW / img.width, photoH / img.height)
      const dw = img.width * scale, dh = img.height * scale
      ctx.drawImage(img, photoX + (photoW - dw) / 2, photoY + (photoH - dh) / 2, dw, dh)
      ctx.restore()
      ctx.filter = 'none'
    } catch (e) {
      console.error('Erreur chargement avatar:', e.message)
    }
  } else {
    ctx.fillStyle = '#888'
    ctx.font = '30px Oswald'
    ctx.fillText('👤', photoX + 32, photoY + 68)
  }

  // ── Champs à droite de la photo ──
  const fx = photoX + photoW + 14
  let fy = 90
  const field = (label, value) => {
    ctx.fillStyle = '#888'
    ctx.font = '7px Oswald'
    ctx.fillText(label, fx, fy)
    ctx.fillStyle = '#1a1a1a'
    ctx.font = 'bold 11px Oswald'
    ctx.fillText(value ?? '—', fx, fy + 12)
    fy += 26
  }

  field('DL/ID#', profile.id_number ?? generateIdNumber(profile.id))
  field('DOB', profile.birth_date)
  if (profile.height) field('HGT', profile.height)
  if (profile.eye_color) field('EYES', profile.eye_color)

  // ── Nom ──
  let y = photoY + photoH + 26
  ctx.fillStyle = '#777'
  ctx.font = '8px Oswald'
  ctx.fillText('LAST NAME, FIRST NAME', 16, y)
  y += 20
  ctx.fillStyle = '#1a1a1a'
  ctx.font = 'bold 20px Oswald'
  ctx.fillText((profile.username ?? '—').toUpperCase(), 16, y)

  // ── Adresse ──
  if (profile.rp_address) {
    y += 24
    ctx.fillStyle = '#777'
    ctx.font = '8px Oswald'
    ctx.fillText('ADDRESS', 16, y)
    y += 14
    ctx.fillStyle = '#222'
    ctx.font = '11px Oswald'
    ctx.fillText(profile.rp_address, 16, y)
    y += 14
    ctx.fillStyle = '#444'
    ctx.font = '10px Oswald'
    ctx.fillText('PHOENIX, AZ', 16, y)
  }

  // ── Lieu de naissance ──
  if (profile.birth_place) {
    y += 22
    ctx.fillStyle = '#777'
    ctx.font = '8px Oswald'
    ctx.fillText('PLACE OF BIRTH', 16, y)
    y += 13
    ctx.fillStyle = '#222'
    ctx.font = '11px Oswald'
    ctx.fillText(profile.birth_place, 16, y)
  }

  // ── Footer navy ──
  ctx.fillStyle = '#1a1a2e'
  ctx.fillRect(0, H - 24, W, 24)
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.font = '8px Oswald'
  ctx.fillText(profile.id_number ?? generateIdNumber(profile.id), 14, H - 9)
  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  ctx.fillText('STATE OF ARIZONA', W - 14, H - 9)
  ctx.textAlign = 'left'

  return canvas.toBuffer('image/png')
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function generateIdNumber(id) {
  const hash = id.replace(/-/g, '').slice(0, 8).toUpperCase()
  return `A${hash.slice(0,3)}-${hash.slice(3,6)}-${hash.slice(6,8)}0`
}

// ═══════════════════════════════════════════════════════════
// RÉSUMÉ PERSONNAGE (job, quartier, 4 stats)
// ═══════════════════════════════════════════════════════════

const fixImgur = url => url.replace('https://imgur.com/', 'https://i.imgur.com/')

const CARD_BACKGROUND_URL = fixImgur('https://imgur.com/96PHtUY.png')

const STAT_DEFS = [
  { key: 'richesse',  label: 'Richesse',  icon: fixImgur('https://imgur.com/8ymiCIF.png'), color: '#f5c344' },
  { key: 'legalite',  label: 'Légalité',  icon: fixImgur('https://imgur.com/8sOK8Tg.png'), color: '#e0a94a' },
  { key: 'social',    label: 'Social',    icon: fixImgur('https://imgur.com/RG2khwT.png'), color: '#e0568f' },
  { key: 'ascension', label: 'Ascension', icon: fixImgur('https://imgur.com/uJIB6A4.png'), color: '#4a90d9' },
]

async function sendProfileCard(characterId, discordUser) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', characterId)
    .maybeSingle()

  if (!profile) {
    await discordUser.send(`❌ Personnage introuvable.`)
    return
  }

  try {
    const buffer = await generateProfileCardImage(profile)
    const attachment = new AttachmentBuilder(buffer, { name: 'fiche-personnage.png' })
    await discordUser.send({
      content: `🪄 Fiche personnage de **${profile.username}**`,
      files: [attachment],
    })
    console.log(`✅ Fiche personnage envoyée à ${discordUser.username}`)
  } catch (e) {
    console.error('❌ Erreur envoi fiche:', e.message)
    try {
      await discordUser.send(`❌ Une erreur est survenue lors de la génération de ta fiche.`)
    } catch {}
  }
}

async function fetchImgBuffer(url) {
  // Le CDN Discord sert une petite vignette par défaut — on force une version haute résolution
  if (url.includes('cdn.discordapp.com') && !url.includes('size=')) {
    url += (url.includes('?') ? '&' : '?') + 'size=512'
  }
  const res = await fetch(url)
  return Buffer.from(await res.arrayBuffer())
}

function getStatValue(stats, key) {
  if (!Array.isArray(stats)) return 50
  const found = stats.find(s => s.key === key)
  return found?.value ?? 50
}

async function generateProfileCardImage(profile) {
  const W = 800, H = 460
  const SCALE = 3 // rendu en haute résolution pour un résultat net sur Discord
  const canvas = createCanvas(W * SCALE, H * SCALE)
  const ctx = canvas.getContext('2d')
  ctx.scale(SCALE, SCALE)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // Fond (image de ville)
  try {
    const bg = await loadImage(await fetchImgBuffer(CARD_BACKGROUND_URL))
    const scale = Math.max(W / bg.width, H / bg.height)
    const dw = bg.width * scale, dh = bg.height * scale
    ctx.drawImage(bg, (W - dw) / 2, (H - dh) / 2, dw, dh)
  } catch (e) {
    console.error('❌ Fond non chargé:', CARD_BACKGROUND_URL, '—', e.message)
    ctx.fillStyle = '#1a1a1a'
    ctx.fillRect(0, 0, W, H)
  }

  // Voile sombre
  const overlay = ctx.createLinearGradient(0, 0, 0, H)
  overlay.addColorStop(0, 'rgba(0,0,0,0.55)')
  overlay.addColorStop(0.45, 'rgba(0,0,0,0.15)')
  overlay.addColorStop(1, 'rgba(0,0,0,0.5)')
  ctx.fillStyle = overlay
  ctx.fillRect(0, 0, W, H)

  // Avatar en haut à gauche
  const avX = 118, avY = 110, avR = 70
  ctx.save()
  ctx.beginPath()
  ctx.arc(avX, avY, avR, 0, Math.PI * 2)
  ctx.closePath()
  ctx.clip()
  if (profile.avatar_url) {
    try {
      const img = await loadImage(await fetchImgBuffer(profile.avatar_url))
      const scale = Math.max((avR * 2) / img.width, (avR * 2) / img.height)
      const dw = img.width * scale, dh = img.height * scale
      ctx.drawImage(img, avX - dw / 2, avY - dh / 2, dw, dh)
    } catch (e) {
      console.error('❌ Avatar non chargé:', profile.avatar_url, '—', e.message)
      drawAvatarFallback(ctx, avX, avY, avR * 2, profile)
    }
  } else {
    drawAvatarFallback(ctx, avX, avY, avR * 2, profile)
  }
  ctx.restore()
  ctx.beginPath()
  ctx.arc(avX, avY, avR, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'
  ctx.lineWidth = 3
  ctx.stroke()

  // Texte à droite de l'avatar
  const textX = avX + avR + 34
  ctx.textAlign = 'left'
  ctx.fillStyle = '#ffffff'
  ctx.font = "800 44px Oswald"
  ctx.fillText(profile.username ?? 'Personnage', textX, 76)
  ctx.font = "600 26px Oswald"
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  ctx.fillText(profile.job || 'Sans emploi', textX, 112)
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.fillText(profile.location || 'Phoenix, AZ', textX, 146)

  // Logo emploi — placé dans la zone entre le texte et l'horizon
  if (profile.job_logo_url) {
    try {
      const logo = await loadImage(await fetchImgBuffer(profile.job_logo_url))
      const boxX = 331, boxY = 93, boxW = 90, boxH = 80
      const fit = Math.min(boxW / logo.width, boxH / logo.height)
      const lw = logo.width * fit, lh = logo.height * fit
      ctx.drawImage(logo, boxX + (boxW - lw) / 2, boxY + (boxH - lh) / 2, lw, lh)
    } catch (e) {
      console.error('❌ Logo emploi non chargé:', profile.job_logo_url, '—', e.message)
    }
  }

  // ── Influence Totale — carte agrandie sur fond gris ──
  const influence = STAT_DEFS.reduce((sum, def) => sum + getStatValue(profile.stats, def.key), 0) / STAT_DEFS.length / 10

  const boxX = 440, boxY = 205, boxW = 315, boxH = 212
  roundRect(ctx, boxX, boxY, boxW, boxH, 18)
  ctx.fillStyle = 'rgba(30,30,34,0.55)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.lineWidth = 1.5
  ctx.stroke()

  const infX = boxX + 26
  ctx.textAlign = 'left'
  ctx.font = "700 18px Oswald"
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.fillText('INFLUENCE TOTALE', infX, boxY + 40)

  ctx.font = "800 64px Oswald"
  ctx.fillStyle = '#ffffff'
  const scoreText = `${influence.toFixed(1)}`
  ctx.fillText(scoreText, infX, boxY + 112)
  const scoreWidth = ctx.measureText(scoreText).width
  ctx.font = "600 26px Oswald"
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  ctx.fillText('/10', infX + scoreWidth + 8, boxY + 112)

  ctx.font = "15px Oswald"
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  ctx.fillText('Calcul : 25% de chaque valeur /100', infX, boxY + 150)
  ctx.fillText('pour former une note finale sur 10', infX, boxY + 170)

  // Badges de stats — colonne gauche
  const stats = profile.stats
  let by = 230
  for (const def of STAT_DEFS) {
    const val = getStatValue(stats, def.key)
    const bx = 70

    // Icône ronde
    ctx.save()
    ctx.beginPath()
    ctx.arc(bx, by, 28, 0, Math.PI * 2)
    ctx.fillStyle = def.color
    ctx.fill()
    try {
      const icon = await loadImage(await fetchImgBuffer(def.icon))
      ctx.beginPath()
      ctx.arc(bx, by, 25, 0, Math.PI * 2)
      ctx.clip()
      ctx.drawImage(icon, bx - 25, by - 25, 50, 50)
    } catch (e) {
      console.error('❌ Icône stat non chargée:', def.icon, '—', e.message)
    }
    ctx.restore()
    ctx.beginPath()
    ctx.arc(bx, by, 28, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'
    ctx.lineWidth = 2
    ctx.stroke()

    // Compteur en 10 blocs à droite de l'icône
    const barX = bx + 46
    ctx.font = "600 14px Oswald"
    ctx.fillStyle = '#fff'
    ctx.fillText(`${def.label.toUpperCase()}  ${val}`, barX, by - 10)

    const filledBlocks = Math.round(val / 10)
    const blockW = 16, blockH = 14, blockGap = 4
    for (let i = 0; i < 10; i++) {
      const blockX = barX + i * (blockW + blockGap)
      roundRect(ctx, blockX, by - 2, blockW, blockH, 3)
      ctx.fillStyle = i < filledBlocks ? def.color : 'rgba(255,255,255,0.12)'
      ctx.fill()
    }

    by += 58
  }

  // Footer
  ctx.textAlign = 'center'
  ctx.font = '13px Oswald'
  ctx.fillStyle = 'rgba(255,255,255,0.3)'
  ctx.fillText('PHOENIX RP · FICHE PERSONNAGE', W / 2, H - 16)
  ctx.textAlign = 'left'

  return canvas.toBuffer('image/png')
}

function drawAvatarFallback(ctx, x, y, size, profile) {
  ctx.fillStyle = profile.avatar_color ?? '#7c3aed'
  ctx.fillRect(x - size / 2, y - size / 2, size, size)
  ctx.fillStyle = '#fff'
  ctx.font = `bold ${size * 0.36}px Oswald`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(profile.initials ?? '?', x, y)
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
}

// ── Sync tous les salons des catégories RP ──────────────────
async function syncAllLocations() {
  for (const guild of client.guilds.cache.values()) {
    const channels = guild.channels.cache.filter(c =>
      c.parentId && RP_CATEGORY_IDS.includes(c.parentId) && c.isTextBased()
    )

    console.log(`🔄 ${channels.size} salons RP trouvés`)

    for (const channel of channels.values()) {
      const channelName = channel.name

      const { data: existing } = await supabase
        .from('map_locations')
        .select('id')
        .ilike('discord_channel', channelName)
        .maybeSingle()

      if (!existing) {
        const { error } = await supabase
          .from('map_locations')
          .insert({
            name:               formatChannelName(channelName),
            discord_channel:    channelName,
            discord_channel_id: channel.id,
            discord_guild_id:   guild.id,
            description:        channel.topic ?? '',
            icon:               '📍',
            color:              '#b96eff',
            lat:                null,
            lng:                null,
          })

        if (!error) {
          console.log(`✅ Lieu créé : "${formatChannelName(channelName)}"`)
        } else {
          console.error(`❌ Erreur création lieu "${channelName}":`, error.message)
        }
      } else {
        await supabase
          .from('map_locations')
          .update({
            discord_channel_id: channel.id,
            discord_guild_id:   guild.id,
          })
          .eq('id', existing.id)
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
