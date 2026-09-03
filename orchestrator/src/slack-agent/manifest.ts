// slack-agent/manifest.ts — Slack app manifest for a self-hosted deployment.
//
// Each deployment creates its OWN Slack app from this manifest (no shared app,
// no marketplace): Socket Mode means no public URL, and tokens never leave the
// team's server. The dashboard's "Add Slack bot" wizard deep-links app
// creation with this manifest prefilled.

export function buildManifest(projectName: string): Record<string, unknown> {
  const name = projectName && projectName !== "flow" ? `Flow (${projectName})` : "Flow";
  return {
    display_information: {
      name,
      description: "Ask Flow — your team's knowledge graph, decisions, and memory",
      background_color: "#1a1d21",
    },
    features: {
      agent_view: {
        agent_description:
          "Ask Flow anything about your codebase, architecture, past decisions, gotchas, and team memory. DM me, mention me in a channel, or add me to a group DM.",
        suggested_prompts: [
          {
            title: "What is this project?",
            message: "Give me an overview of this project — what it is and how it fits together.",
          },
          {
            title: "Find a past decision",
            message: "What did we decide about deployment and infrastructure?",
          },
          {
            title: "Explain a failure",
            message: "Have we seen this error before?",
          },
        ],
      },
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: name,
        always_online: true,
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "assistant:write",
          "chat:write",
          "channels:history",
          "channels:read",
          "groups:history",
          "groups:read",
          "im:history",
          "im:read",
          "im:write",
          "mpim:history",
          "mpim:read",
          "mpim:write",
          "users:read",
          "reactions:write",
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: [
          "app_home_opened",
          "app_mention",
          "assistant_thread_started",
          "assistant_thread_context_changed",
          "agent_session_stopped",
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim",
        ],
      },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

/** Deep link that opens Slack's app-creation dialog with the manifest prefilled. */
export function createAppUrl(projectName: string): string {
  const manifest = JSON.stringify(buildManifest(projectName));
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(manifest)}`;
}
