export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const path = req.url.split("/api/football")[1] || "/status";
    const url = "https://v3.football.api-sports.io" + path;

    const response = await fetch(url, {
      headers: { "x-apisports-key": process.env.API_FOOTBALL_KEY }
    });

    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
