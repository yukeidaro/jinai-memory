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
        title: "ハンバーグが好き",
        summary: "夕飯には、ふっくらしたハンバーグを好む。",
        text: "## 好み\n夕飯はハンバーグが好き。きのこのソースと温野菜を添えると嬉しい。",
        tags: ["ハンバーグ", "夕飯", "晩ごはん", "夕食", "献立"],
      },
    },
    {
      source: "chatgpt",
      arguments: {
        kind: "event",
        title: "夕飯にハンバーグを食べた",
        summary: "昨日の夕飯は、きのこソースのハンバーグと温野菜だった。",
        occurredAt: yesterday.toISOString(),
        text: [
          "# 夕飯にハンバーグを食べた",
          "",
          "昨日は、きのこソースのハンバーグを作って食べた。これは架空のデモ用の記録。",
          "",
          "## 材料（2人分）",
          "- 合いびき肉 250g",
          "- 玉ねぎ 1/2個、卵 1個、パン粉 大さじ3、牛乳 大さじ2",
          "- きのこ 100g、ケチャップ 大さじ2、ソース 大さじ1、水 大さじ3",
          "- 付け合わせの温野菜",
          "",
          "## 作り方",
          "1. 玉ねぎをみじん切りにして炒め、冷ます。",
          "2. 肉、玉ねぎ、卵、牛乳に浸したパン粉を混ぜ、小判形にする。",
          "3. 両面を焼き、水を加えて蓋をし、中心まで十分に火を通す。",
          "4. きのこと調味料を煮詰めたソースをかけ、温野菜を添える。",
          "",
          "## メモ",
          "おいしかったので、次の夕飯を提案するときは昨日と同じ料理の連続に注意する。",
        ].join("\n"),
        tags: ["ハンバーグ", "夕飯", "晩ごはん", "夕食", "レシピ"],
        relatesTo: ["ハンバーグが好き"],
      },
    },
    {
      source: "claude",
      arguments: {
        kind: "preference",
        title: "旅では静かな水辺を歩くのが好き",
        summary: "架空の旅行メモ。混雑した観光地より、静かな水辺の散歩を好む。",
        text: "## 旅の好み\n水辺をゆっくり歩き、景色をスケッチする時間が好き。予約や日程はまだ決めない。",
        tags: ["旅行", "旅", "お出かけ", "散歩"],
      },
    },
    {
      source: "claude",
      arguments: {
        kind: "fact",
        title: "架空の湖畔旅行の記録",
        summary: "架空の湖畔で木の葉と水面をスケッチした。",
        text: "## 旅の記録\n架空の湖畔を散歩し、水面と木の葉を描いた。実在の場所や人物とは関係のない記録。",
        tags: ["旅行", "旅", "お出かけ", "スケッチ"],
        relatesTo: ["旅では静かな水辺を歩くのが好き"],
      },
    },
    {
      source: "claude",
      arguments: {
        kind: "preference",
        title: "仕事のメモは短い箇条書きがよい",
        summary: "架空の作業では、要点と判断理由を短い箇条書きで残す。",
        text: "## メモの好み\n長い議事録より、要点・判断理由・未解決の疑問を短く残す方式が読み返しやすい。",
        tags: ["仕事", "作業", "業務", "メモ"],
      },
    },
    {
      source: "claude",
      arguments: {
        kind: "fact",
        title: "買い物では在庫を先に確認する",
        summary: "架空の生活メモ。買い物リストを作る前に、冷蔵庫と棚の在庫を確認する。",
        text: "## 買い物の習慣\n冷蔵庫と棚を確認してから不足分だけをリストにする。具体的な購入予定はまだない。",
        tags: ["買い物", "買物", "購入", "在庫", "献立"],
      },
    },
    {
      source: "cursor",
      arguments: {
        kind: "decision",
        title: "献立アプリの設計メモ",
        summary: "架空の個人制作アプリでは、好みと食事の履歴を分けて保存する。",
        text: "## 献立アプリの設計\n- 好みは preference、食べた記録は event として分ける。\n- 直近の夕食履歴を確認してから候補を提案する。\n- まだ実装日や公開予定は決めない。",
        tags: ["献立", "メニュー", "食事計画", "夕飯", "設計"],
        relatesTo: ["ハンバーグが好き", "夕飯にハンバーグを食べた"],
      },
    },
    {
      source: "cursor",
      arguments: {
        kind: "fact",
        title: "献立データは日付と種類で分ける",
        summary: "架空の設計メモ。食事の履歴には日時を持たせ、好みには予定日を持たせない。",
        text: "## データの整理\n履歴の日付と記憶の作成日は別の項目にする。食べ物の好みを、今日食べる予定として扱わない。",
        tags: ["献立", "メニュー", "食事計画", "設計"],
        relatesTo: ["献立アプリの設計メモ"],
      },
    },
    {
      source: "copilot",
      arguments: {
        kind: "fact",
        title: "買い物リストのスクリプト",
        summary: "架空の試作スクリプトで、必要な材料から在庫分を引いてリストを作る。",
        text: "## 買い物リストの試作\n```js\nconst missing = ingredients.filter((item) => !pantry.has(item));\nconsole.log(missing.join(\"\\n\"));\n```\n材料と在庫は架空の入力。外部サービスや個人情報は使わない。",
        tags: ["買い物", "買物", "購入", "在庫", "スクリプト"],
        relatesTo: ["買い物では在庫を先に確認する", "献立アプリの設計メモ"],
      },
    },
    {
      source: "copilot",
      arguments: {
        kind: "decision",
        title: "買い物リストは重複をまとめる",
        summary: "架空の試作では、材料名の表記を揃えて重複した項目をまとめる。",
        text: "## 重複の扱い\n材料名の前後の空白を除き、同じ項目をまとめる。まずは手元の架空データだけで動作を確認する。",
        tags: ["買い物", "買物", "購入", "スクリプト"],
        relatesTo: ["買い物リストのスクリプト"],
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
