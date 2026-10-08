"use client";

import { use } from "react";
import Link from "next/link";
import { getAgent } from "@/lib/agents";
import { Avatar } from "../../../fleet-shared";
import ChatPanel from "../chat-panel";

/** Popup-sized chat window (opened by the assistant dock in the other BLP apps). */
export default function AgentChatPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const agent = getAgent(slug);
  if (!agent) return <div className="banner bad">No agent named “{slug}”. <Link href="/">Back</Link></div>;
  return (
    <div className="chat-popup">
      <div className="page-head" style={{ alignItems: "center", gap: 12, marginBottom: 8 }}>
        <Avatar agent={agent} size={40} live={agent.status === "live"} />
        <div><h1 style={{ margin: 0, fontSize: 18 }}>{agent.name}</h1><div className="muted" style={{ fontSize: 12 }}>{agent.role} · {agent.provider === "grokbot" ? "Ivory Grok Bot" : "answers from the Knowledge Vault"}</div></div>
        <span style={{ flex: 1 }} />
        <Link href={`/agents/${agent.slug}`} className="crumb">Full page →</Link>
      </div>
      <ChatPanel agent={agent} compact />
    </div>
  );
}
