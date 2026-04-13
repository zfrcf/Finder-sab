const axios = require('axios');

// Cette variable stocke les derniers serveurs trouvés en mémoire
let serverCache = [];

export default async function handler(req, res) {
    const WEBHOOK_URL = "https://discord.com/api/webhooks/1468693159323369646/YXIBK1FWCp32stvulAygT-eqwZtrVxg4fOBj5XQxIUIh1uoiaVyFduX22jnTHF1OPFx-";

    // --- PARTIE 1 : RÉCUPÉRATION (Pour le Site Web et le Script Client) ---
    if (req.method === 'GET') {
        return res.status(200).json(serverCache);
    }

    // --- PARTIE 2 : RÉCEPTION (Envoyé par le Finder en jeu) ---
    if (req.method === 'POST') {
        const { brainrotName, gps, jobId, placeId } = req.body;

        // Mise à jour de la mémoire du site
        const newServer = { brainrotName, gps, jobId, placeId, date: new Date() };
        serverCache.unshift(newServer); 
        
        // On ne garde que les 5 meilleurs pour ne pas saturer
        if (serverCache.length > 5) serverCache.pop();

        // Envoi au Webhook Discord
        const robloxLink = `roblox://placeId=${placeId}&gameInstanceId=${jobId}`;
        const payload = {
            username: "SoloCheat Scanner 🧠",
            embeds: [{
                title: "🚀 SERVEUR BRAINROT DÉTECTÉ",
                color: 0xFF0050,
                fields: [
                    { name: "💎 Objet Rare", value: `**${brainrotName}**`, inline: true },
                    { name: "💰 Argent/sec", value: `\`${gps} /s\``, inline: true },
                    { name: "📊 Serveur", value: `\`${jobId}\``, inline: false }
                ],
                description: `### [REJOINDRE LE SERVEUR](${robloxLink})`,
                timestamp: new Date()
            }]
        };

        try {
            await axios.post(WEBHOOK_URL, payload);
            return res.status(200).json({ success: true });
        } catch (err) {
            return res.status(500).json({ error: "Erreur Discord" });
        }
    }

    return res.status(405).json({ error: "Méthode non autorisée" });
}
