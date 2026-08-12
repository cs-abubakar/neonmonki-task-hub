/**
 * Default users and channels, inserted when the workspace is empty
 * (first boot on JSON storage, or after running the SQL migrations on Supabase).
 *
 * Default passwords are documented in README — the super admin changes them
 * from the Admin page. ADIKA_PASSWORD / TEAM_PASSWORD / ADMIN_PASSWORD env
 * vars override the three main accounts at bootstrap time only.
 */
"use strict";

const crypto = require("crypto");

function hashPassword(username, password) {
  return crypto.scryptSync(password, "nm-task-hub:" + username, 32).toString("hex");
}

function defaultUsers() {
  const defs = [
    // username, display name, role, org, default password
    ["abubakar", "Abu Bakar", "super_admin", "Advertidea", process.env.ADMIN_PASSWORD || "NM-admin-2026"],
    ["adika", "Adika", "client", "NEONMONKI", process.env.ADIKA_PASSWORD || "neonmonki2026"],
    ["advertidea", "Advertidea Team", "team", "Advertidea", process.env.TEAM_PASSWORD || "advertidea2026"],
    ["hafeez", "Hafeez", "team", "Advertidea", "NM-hafeez-2026"],
    ["areeb", "Areeb", "team", "Advertidea", "NM-areeb-2026"],
    ["taha", "Taha", "team", "Advertidea", "NM-taha-2026"],
    ["usama", "Usama", "team", "Advertidea", "NM-usama-2026"],
    ["sana", "Sana", "team", "Advertidea", "NM-sana-2026"],
    ["munsif", "Munsif", "team", "Advertidea", "NM-munsif-2026"],
    ["mateen", "Mateen", "team", "Advertidea", "NM-mateen-2026"],
    ["taimoor", "Taimoor", "team", "Advertidea", "NM-taimoor-2026"],
  ];
  return defs.map(([username, name, role, org, password]) => ({
    username,
    name,
    role,
    org,
    active: true,
    passwordHash: hashPassword(username, password),
  }));
}

// autoAll = every user is implicitly a member (General).
// clientAllowed = the client account may be added as a member.
// members = seeded membership for non-autoAll channels (super admin can change anytime).
function defaultChannels() {
  return [
    {
      id: "general", name: "General", department: "Project Management",
      description: "Whole workspace — team + client. Everyone is here.",
      autoAll: true, clientAllowed: true, members: [],
    },
    {
      id: "strategies-planning", name: "Strategies & Planning", department: "Project Management",
      description: "Direction, roadmaps, meeting outcomes. Client included.",
      autoAll: false, clientAllowed: true,
      members: ["abubakar", "hafeez", "areeb", "adika"],
    },
    {
      id: "google-ads", name: "Google Ads", department: "Paid Marketing",
      description: "Campaigns, budgets, tracking, HYROS/Salesforce work.",
      autoAll: false, clientAllowed: false,
      members: ["abubakar", "taha", "hafeez", "areeb", "mateen"],
    },
    {
      id: "seo", name: "SEO", department: "SEO - Technical",
      description: "Technical SEO, content pipeline, GMB, local pages.",
      autoAll: false, clientAllowed: false,
      members: ["abubakar", "usama", "sana", "hafeez"],
    },
    {
      id: "email-marketing", name: "Email Marketing", department: "Email Marketing",
      description: "Cold outreach, newsletters, lists, deliverability.",
      autoAll: false, clientAllowed: false,
      members: ["abubakar", "munsif", "hafeez"],
    },
    {
      id: "social-media", name: "Social Media", department: "Social Media",
      description: "Pinterest, Meta retargeting, organic social.",
      autoAll: false, clientAllowed: false,
      members: ["abubakar", "sana", "munsif"],
    },
    {
      id: "ai-automation", name: "AI Automation", department: "AI & Automation",
      description: "Configurator prototype, AI workflows, agent tooling.",
      autoAll: false, clientAllowed: false,
      members: ["abubakar", "taimoor", "hafeez"],
    },
    {
      id: "research", name: "Research", department: "SEO - Research",
      description: "Market/competitor research, Italy expansion intel.",
      autoAll: false, clientAllowed: false,
      members: ["abubakar", "sana", "usama", "areeb"],
    },
  ];
}

module.exports = { defaultUsers, defaultChannels, hashPassword };
