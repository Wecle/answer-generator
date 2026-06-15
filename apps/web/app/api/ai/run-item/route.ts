export async function POST(request: Request) {
  const body = await request.json();
  const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8001";
  const response = await fetch(`${aiServiceUrl}/ai/run-item`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  return new Response(await response.text(), {
    status: response.status,
    headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/json" }
  });
}

