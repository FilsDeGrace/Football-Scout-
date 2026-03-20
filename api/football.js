export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const path = req.url.replace("/api/football", "") || "/fixtures";
    const url = "https://v3.football.api-sports.io" + path;

    console.log("Fetching:", url);
    console.log("Key present:", !!process.env.API_FOOTBALL_KEY);

    const response = await fetch(url, {
      headers: { 
        "x-apisports-key": process.env.API_FOOTBALL_KEY,
        "Content-Type": "application/json"
      }
    });

    const data = await response.json();
    res.status(200).json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
