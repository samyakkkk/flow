import { createFileRoute } from "@tanstack/react-router";
import { LiveBrainPage } from "../components/brain/LiveBrainPage";
export const Route = createFileRoute("/brain")({ component: LiveBrainPage });
