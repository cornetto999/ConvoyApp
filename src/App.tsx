import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import ConvoyDashboard from "./pages/ConvoyDashboard";
import ConvoyMap from "./pages/ConvoyMap";
import ConvoyAlerts from "./pages/ConvoyAlerts";
import MapExamples from "./pages/MapExamples";
import NotFound from "./pages/NotFound";
import OAuthBridge from "./pages/OAuthBridge";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/login" element={<Auth />} />
            <Route path="/~oauth/initiate" element={<OAuthBridge />} />
            <Route path="/~oauth/complete" element={<OAuthBridge />} />
            <Route path="/map-examples" element={<MapExamples />} />
            <Route path="/convoy/:id" element={<ConvoyDashboard />} />
            <Route path="/convoy/:id/map" element={<ConvoyMap />} />
            <Route path="/convoy/:id/alerts" element={<ConvoyAlerts />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
