import { Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense } from "react";
import { Layout } from "@/client/components/Layout";
import { Loading } from "@/client/components/Ui";

const Overview = lazy(() => import("@/client/pages/Overview").then((module) => ({ default: module.Overview })));
const Requests = lazy(() => import("@/client/pages/Requests").then((module) => ({ default: module.Requests })));
const Security = lazy(() => import("@/client/pages/Security").then((module) => ({ default: module.Security })));
const Archives = lazy(() => import("@/client/pages/Archives").then((module) => ({ default: module.Archives })));
const Settings = lazy(() => import("@/client/pages/Settings").then((module) => ({ default: module.Settings })));

export function App() {
  return <Suspense fallback={<Loading />}><Routes><Route element={<Layout />}><Route index element={<Overview />} /><Route path="requests" element={<Requests />} /><Route path="security" element={<Security />} /><Route path="archives" element={<Archives />} /><Route path="settings" element={<Settings />} /><Route path="*" element={<Navigate to="/" replace />} /></Route></Routes></Suspense>;
}
