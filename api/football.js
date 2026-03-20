export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const url = new URL("https://v3.football.api-sports.io" + req.url.replace("/api/football", ""));
  
  const response = await fetch(url.toString(), {
    headers: { "x-apisports-key": process.env.API_FOOTBALL_KEY }
  });

  const data = await response.json();
  res.status(200).json(data);
}
