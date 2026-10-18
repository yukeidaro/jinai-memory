import path from "node:path";
import { fileURLToPath } from "node:url";

function demoMemories() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);
  return [
    {
      source: "chatgpt",
      arguments: {
        kind: "preference",
        title: "Loves burgers",
        summary: "Burgers with crisp lettuce and tomato are a favorite dinner.",
        text: "## Food preferences\nLoves burgers for dinner, especially with crisp lettuce, tomato and a toasted bun. This is a fictional demo preference.",
        tags: ["burgers", "dinner", "food", "preferences", "meal planning"],
      },
    },
    {
      source: "chatgpt",
      arguments: {
        kind: "event",
        title: "Dinner: burgers",
        summary: "Yesterday's dinner was homemade burgers with lettuce, tomato and oven fries.",
        occurredAt: yesterday.toISOString(),
        text: [
          "# Dinner: burgers",
          "",
          "Made burgers for dinner yesterday. This is a fictional demo record.",
          "",
          "## Ingredients (serves 2)",
          "- 300 g ground beef and 2 burger buns",
          "- Lettuce, tomato, cheese and ketchup",
          "- Potatoes for oven fries",
          "",
          "## Method",
          "1. Shape and season two beef patties; bake the potato wedges.",
          "2. Cook the patties thoroughly to 160 F (71 C) in the center.",
          "3. Toast the buns and assemble with lettuce, tomato, cheese and ketchup.",
          "",
          "## Note",
          "Enjoyed the burgers. Check recent dinners before suggesting the same meal again.",
        ].join("\n"),
        tags: ["burgers", "dinner", "food", "recipe", "meal planning"],
        relatesTo: ["Loves burgers"],
      },
    },
    {
      source: "claude",
      arguments: {
        kind: "preference",
        title: "Prefers quiet waterside walks",
        summary: "A fictional travel preference: quiet walks by the water rather than crowded attractions.",
        text: "## Travel preferences\nEnjoys slow walks by the water and sketching the scenery. No bookings or travel dates are planned.",
        tags: ["travel", "walks", "water", "sketching"],
      },
    },
    {
      source: "claude",
      arguments: {
        kind: "fact",
        title: "Fictional lakeside sketching trip",
        summary: "Sketched leaves and reflections beside an imaginary lake.",
        text: "## Travel notes\nWalked beside an imaginary lake and sketched the water and leaves. This fictional note is unrelated to real people or places.",
        tags: ["travel", "walks", "water", "sketching"],
        relatesTo: ["Prefers quiet waterside walks"],
      },
    },
    {
      source: "claude",
      arguments: {
        kind: "preference",
        title: "Prefers short bullet-point work notes",
        summary: "For fictional projects, keep key points and decision reasons in short bullets.",
        text: "## Note preferences\nShort lists of key points, decision reasons and open questions are easier to review than long meeting minutes.",
        tags: ["work", "notes", "writing", "decisions"],
      },
    },
    {
      source: "claude",
      arguments: {
        kind: "fact",
        title: "Checks the pantry before shopping",
        summary: "A fictional household habit: check the fridge and pantry before making a shopping list.",
        text: "## Shopping habits\nCheck the fridge and pantry, then list only missing ingredients. No shopping trip is scheduled.",
        tags: ["shopping", "groceries", "pantry", "food", "meal planning"],
      },
    },
    {
      source: "cursor",
      arguments: {
        kind: "decision",
        title: "Meal planner design notes",
        summary: "A fictional hobby app stores food preferences separately from meal history.",
        text: "## Meal planner design\n- Store preferences as preference notes and meals as dated events.\n- Check recent dinners before suggesting a meal.\n- No implementation or release date is planned.",
        tags: ["meal planning", "menu", "food", "dinner", "design"],
        relatesTo: ["Loves burgers", "Dinner: burgers"],
      },
    },
    {
      source: "cursor",
      arguments: {
        kind: "fact",
        title: "Separate meal dates from memory kinds",
        summary: "A fictional design note: date meal events, but do not assign a planned date to preferences.",
        text: "## Data organization\nKeep an event's date separate from the note's creation date. A food preference is not a plan to eat that food today.",
        tags: ["meal planning", "menu", "food", "design"],
        relatesTo: ["Meal planner design notes"],
      },
    },
    {
      source: "copilot",
      arguments: {
        kind: "fact",
        title: "Shopping list script",
        summary: "A fictional prototype subtracts pantry items from the required ingredients.",
        text: "## Shopping list prototype\n```js\nconst missing = ingredients.filter((item) => !pantry.has(item));\nconsole.log(missing.join(\"\\n\"));\n```\nIngredients and pantry items are fictional inputs. No external services or personal data are used.",
        tags: ["shopping", "groceries", "pantry", "food", "scripts"],
        relatesTo: ["Checks the pantry before shopping", "Meal planner design notes"],
      },
    },
    {
      source: "copilot",
      arguments: {
        kind: "decision",
        title: "Deduplicate shopping list items",
        summary: "The fictional prototype normalizes ingredient names and merges duplicate items.",
        text: "## Duplicate handling\nTrim surrounding whitespace from ingredient names and merge matching items. Check behavior using only local fictional data first.",
        tags: ["shopping", "groceries", "pantry", "scripts"],
        relatesTo: ["Shopping list script"],
      },
    },
  ];
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((arg) => arg !== "--dry-run");
  if (positional.length !== 2 || !positional[1].trim()) {
    throw new Error("Usage: node scripts\\seed-demo.mjs <base-url> <token> [--dry-run]");
  }
  let base;
  try {
    base = new URL(positional[0]);
  } catch {
    throw new Error("The server address must be an HTTP or HTTPS URL.");
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
    throw new Error("The server address must be an HTTP or HTTPS URL without credentials.");
  }
  const memories = demoMemories();
  if (dryRun) {
    console.log(JSON.stringify(memories, null, 2));
    return;
  }
  for (const [index, note] of memories.entries()) {
    const endpoint = new URL(`/mcp/${encodeURIComponent(positional[1])}-${note.source}`, base);
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: index + 1, method: "tools/call",
          params: { name: "remember", arguments: note.arguments },
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(`Could not reach the MCP server while seeding ${note.source}.`);
    }
    if (!response.ok) {
      throw new Error(`MCP request failed for ${note.source} (HTTP ${response.status}).`);
    }
    let reply;
    try {
      reply = await response.json();
    } catch {
      throw new Error(`MCP returned invalid JSON for ${note.source}.`);
    }
    if (
      reply?.jsonrpc !== "2.0" || reply.id !== index + 1 || reply.error ||
      reply.result?.isError || !Array.isArray(reply.result?.content)
    ) {
      throw new Error(`MCP remember failed for ${note.source}.`);
    }
    let saved;
    try {
      saved = JSON.parse(reply.result.content.find((item) => item.type === "text")?.text);
    } catch {
      throw new Error(`MCP returned an invalid remember result for ${note.source}.`);
    }
    if (typeof saved?.id !== "string" || !saved.id) {
      throw new Error(`MCP returned no memory id for ${note.source}.`);
    }
  }
  console.log("Seeded 10 demo memories (chatgpt=2, claude=4, cursor=2, copilot=2).");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
