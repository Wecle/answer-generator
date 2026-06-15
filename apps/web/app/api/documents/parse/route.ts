export async function POST(request: Request) {
  const formData = await request.formData();
  const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8001";
  const response = await fetch(`${aiServiceUrl}/ai/parse-docx`, {
    method: "POST",
    body: formData
  });

  return new Response(await response.text(), {
    status: response.status,
    headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/json" }
  });
}

