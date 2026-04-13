const axios = require('axios');

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Interdit');

    const { brainrotName, gps, jobId, placeId } = req.body;
    
    // Ton Webhook fourni
    const WEBHOOK_URL = "https://discord.com/api/webhooks/1468693159323369646/YXIBK1FWCp32stvulAygT-eqwZtrVxg4fOBj5XQxIUIh1uoiaVyFduX22jnTHF1OPFx-";

    // Lien de connexion directe (Protocol URI)
    const robloxLink = `roblox://placeId=${placeId}&gameInstanceId=${jobId}`;

    const payload = {
        username: "SoloCheat Scanner 🧠",
        avatar_url: "https://i.imgur.com/AfFp7pu.png",
        embeds: [{
            title: "🚀 SERVEUR BRAINROT DÉTECTÉ",
            color: 0xFF0050,
            fields: [
                { name: "💎 Objet Rare", value: `**${brainrotName}**`, inline: true },
                { name: "💰 Argent/sec", value: `\`${gps} /s\``, inline: true },
                { name: "📊 Serveur", value: `\`${jobId}\``, inline: false }
            ],
            description: `### [REJOINDRE LE SERVEUR MAINTENANT](${robloxLink})\n*Clique sur le lien pour lancer Roblox et te connecter directement.*`,
            footer: { text: "Scanner en direct de Steal a Brainrot" },
            timestamp: new Date()
        }]
    };

    try {
        await axios.post(WEBHOOK_URL, payload);
        res.status(200).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Erreur Webhook" });
    }
}
