import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader,
  DialogTitle, DialogTrigger
} from "@/components/ui/dialog";
import {
  Map as AppMap,
  MapMarker,
  MarkerContent,
  MarkerPopup,
  type MapViewport,
} from "@/components/ui/map";
import { toast } from "sonner";
import {
  Navigation, Copy, MapPin, Users, ArrowLeft, Crown,
  Eye, Shield, UserMinus, Play, Square, AlertTriangle,
  Radio, Bell, RefreshCw
} from "lucide-react";
import type { Convoy, ConvoyMember, Profile } from "@/types/convoy";
import {
  getCuratedDestinationSuggestions,
  getQuickDestinationSuggestions,
  mergeDestinationSuggestions,
  type DestinationSuggestion,
} from "@/lib/destination-suggestions";

type MemberWithProfile = ConvoyMember & { profiles: Profile | null };

function DestinationPreviewPin() {
  return (
    <div className="relative flex flex-col items-center">
      <div className="relative flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-[hsl(var(--accent))] text-xs font-black text-white shadow-xl">
        D
      </div>
      <div className="-mt-1 h-3 w-3 rotate-45 rounded-[2px] border-r-2 border-b-2 border-white bg-[hsl(var(--accent))] shadow-md" />
    </div>
  );
}

export default function ConvoyDashboard() {
  const { id } = useParams<{ id: string }>();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [convoy, setConvoy] = useState<Convoy | null>(null);
  const [members, setMembers] = useState<MemberWithProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [destinationInput, setDestinationInput] = useState("");
  const [destinationSuggestions, setDestinationSuggestions] = useState<DestinationSuggestion[]>([]);
  const [searchingDest, setSearchingDest] = useState(false);
  const [selectedCoords, setSelectedCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [miniViewport, setMiniViewport] = useState<MapViewport | null>(null);
  const [settingDest, setSettingDest] = useState(false);
  const [regroupOpen, setRegroupOpen] = useState(false);
  const [regroupMessage, setRegroupMessage] = useState("");
  const quickDestinationSuggestions = useMemo(() => getQuickDestinationSuggestions(6), []);
  const skipDestinationSearchRef = useRef(false);

  useEffect(() => {
    if (!id || !user) return;
    loadConvoy();
    loadMembers();

    const convoyChannel = supabase
      .channel(`convoy-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "convoys", filter: `id=eq.${id}` },
        () => loadConvoy()
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "convoy_members", filter: `convoy_id=eq.${id}` },
        () => loadMembers()
      )
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "convoy_alerts", filter: `convoy_id=eq.${id}` },
        (payload) => {
          const alert = payload.new as any;
          if (alert.type === "regroup") {
            toast.warning(alert.message || "Regroup called!", { duration: 8000 });
          } else {
            toast.info(alert.message || `Alert: ${alert.type}`);
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(convoyChannel); };
  }, [id, user]);

  // Redirect if not authenticated once auth resolved
  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/login", { replace: true });
      setLoading(false);
    }
  }, [authLoading, user, navigate]);

  useEffect(() => {
    const coords = selectedCoords
      ?? (convoy?.destination_lat && convoy.destination_lng
        ? { lat: convoy.destination_lat, lng: convoy.destination_lng }
        : null);

    if (!coords) {
      setMiniViewport(null);
      return;
    }

    setMiniViewport({
      center: [coords.lng, coords.lat],
      zoom: 13,
      bearing: 0,
      pitch: 0,
    });
  }, [
    convoy?.destination_lat,
    convoy?.destination_lng,
    selectedCoords?.lat,
    selectedCoords?.lng,
  ]);

  const loadConvoy = async () => {
    try {
      const { data, error } = await supabase.from("convoys").select("*").eq("id", id!).single();
      if (error) {
        toast.error(error.message || "Failed to load convoy");
        return;
      }

      setConvoy(data);
      if (data?.destination_lat && data?.destination_lng) {
        setSelectedCoords({ lat: data.destination_lat, lng: data.destination_lng });
      } else if (data?.destination_address) {
        const geocoded = await geocodeAddress(data.destination_address);
        if (geocoded) {
          setSelectedCoords(geocoded);
        }
      }
    } catch (error) {
      console.error("Failed to load convoy:", error);
      toast.error("Failed to load convoy");
    } finally {
      setLoading(false);
    }
  };

  const loadMembers = async () => {
    try {
      const { data, error } = await supabase.from("convoy_members").select("*").eq("convoy_id", id!);

      if (error) {
        if (error.code === "PGRST301" || error.code === "PGRST302" || error.code === "invalid_jwt") {
          toast.error("Session expired. Please sign in again.");
          await supabase.auth.signOut();
          navigate("/login");
        } else {
          toast.error(error.message || "Failed to load members");
        }
        return;
      }

      if (data && data.length > 0) {
        const userIds = data.map((m) => m.user_id);
        const { data: profiles } = await supabase.from("profiles").select("*").in("user_id", userIds);
        const profileById = new Map(profiles?.map((p) => [p.user_id, p]) || []);
        const withProfiles = data.map((m) => ({ ...m, profiles: profileById.get(m.user_id) || null }));
        setMembers(withProfiles as MemberWithProfile[]);
        const me = withProfiles.find((m) => m.user_id === user?.id);
        setMyRole(me?.role ?? null);
      } else {
        setMembers([]);
        setMyRole(null);
      }
    } catch (error) {
      console.error("Failed to load members:", error);
      toast.error("Failed to load members");
    }
  };

  const copyCode = () => {
    if (convoy?.code) {
      navigator.clipboard.writeText(convoy.code);
      toast.success("Code copied!");
    }
  };

  const handleStartConvoy = async () => {
    await supabase.from("convoys").update({ status: "active" }).eq("id", id!);
    await supabase.from("trip_events").insert({
      convoy_id: id!,
      event_type: "convoy.started",
      user_id: user!.id,
    });
    toast.success("Convoy is now active!");
  };

  const handleEndConvoy = async () => {
    await supabase.from("convoys").update({ status: "completed" }).eq("id", id!);
    await supabase.from("trip_events").insert({
      convoy_id: id!,
      event_type: "convoy.completed",
      user_id: user!.id,
    });
    toast.success("Convoy completed!");
  };

  const handleLeaveConvoy = async () => {
    await supabase.from("convoy_members").delete().eq("convoy_id", id!).eq("user_id", user!.id);
    await supabase.from("trip_events").insert({
      convoy_id: id!,
      event_type: "convoy.member_left",
      user_id: user!.id,
    });
    toast.info("You left the convoy");
    navigate("/");
  };

  const handleSetDestination = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedAddress = destinationInput.trim();
    if (!trimmedAddress) return;

    setSettingDest(true);
    try {
      const resolvedCoords = selectedCoords ?? await geocodeAddress(trimmedAddress);

      await supabase.from("convoys").update({
        destination_address: trimmedAddress,
        destination_lat: resolvedCoords?.lat ?? null,
        destination_lng: resolvedCoords?.lng ?? null,
      }).eq("id", id!);
      await supabase.from("trip_events").insert({
        convoy_id: id!,
        event_type: "convoy.destination_set",
        user_id: user!.id,
        payload: { address: trimmedAddress },
      });

      setSelectedCoords(resolvedCoords);
      setDestinationInput("");
      setDestinationSuggestions([]);
      toast.success("Destination set!");
    } catch {
      toast.error("Failed to set destination");
    } finally {
      setSettingDest(false);
    }
  };

  const handleCallRegroup = async () => {
    try {
      await supabase.from("convoy_alerts").insert({
        convoy_id: id!,
        type: "regroup" as const,
        created_by: user!.id,
        message: regroupMessage || "Leader has called a regroup. Pull over safely.",
      });
      await supabase.from("trip_events").insert({
        convoy_id: id!,
        event_type: "convoy.regroup_called",
        user_id: user!.id,
        payload: { message: regroupMessage },
      });
      setRegroupOpen(false);
      setRegroupMessage("");
      toast.success("Regroup alert sent to all members!");
    } catch {
      toast.error("Failed to send regroup alert");
    }
  };

  const handleRemoveMember = async (memberId: string, memberUserId: string) => {
    try {
      await supabase.from("convoy_members").delete().eq("id", memberId);
      await supabase.from("trip_events").insert({
        convoy_id: id!,
        event_type: "convoy.member_left",
        user_id: memberUserId,
        payload: { removed_by: user!.id },
      });
      toast.success("Member removed");
    } catch {
      toast.error("Failed to remove member");
    }
  };

  // Destination autocomplete (Nominatim)
  useEffect(() => {
    if (skipDestinationSearchRef.current) {
      skipDestinationSearchRef.current = false;
      setDestinationSuggestions([]);
      setSearchingDest(false);
      return;
    }

    if (!destinationInput.trim()) {
      setDestinationSuggestions([]);
      setSearchingDest(false);
      return;
    }

    const curatedSuggestions = getCuratedDestinationSuggestions(destinationInput, 6);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearchingDest(true);
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(destinationInput)}&format=json&limit=5`;
        const res = await fetch(url, {
          headers: { "Accept-Language": "en", "User-Agent": "ConvoyApp/1.0" },
          signal: controller.signal,
        });
        const json = await res.json();
        const remoteSuggestions = (json || []).map((r: any) => ({
          display_name: r.display_name as string,
          lat: parseFloat(r.lat),
          lon: parseFloat(r.lon),
          source: "search" as const,
        }));
        setDestinationSuggestions(
          mergeDestinationSuggestions(curatedSuggestions, remoteSuggestions, 8),
        );
      } catch (_) {
        if (!controller.signal.aborted) setDestinationSuggestions(curatedSuggestions);
      } finally {
        setSearchingDest(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [destinationInput]);

  const handleSelectSuggestion = async (s: DestinationSuggestion) => {
    skipDestinationSearchRef.current = true;
    setDestinationInput(s.display_name);
    setDestinationSuggestions([]);
    if (typeof s.lat === "number" && typeof s.lon === "number") {
      setSelectedCoords({ lat: s.lat, lng: s.lon });
      return;
    }

    setSearchingDest(true);
    const resolvedCoords = await geocodeAddress(s.display_name);
    setSearchingDest(false);

    if (!resolvedCoords) {
      toast.error("We couldn't find that destination yet. Try a more specific place name.");
      return;
    }

    setSelectedCoords(resolvedCoords);
  };

  const geocodeAddress = async (address: string): Promise<{ lat: number; lng: number } | null> => {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
      const res = await fetch(url, {
        headers: { "Accept-Language": "en", "User-Agent": "ConvoyApp/1.0" },
      });
      const json = await res.json();
      const hit = json?.[0];
      if (!hit) return null;
      return {
        lat: parseFloat(hit.lat),
        lng: parseFloat(hit.lon),
      };
    } catch {
      return null;
    }
  };

  const isLeader = myRole === "leader" || convoy?.leader_id === user?.id;
  const shouldShowQuickPicks = isLeader && !destinationInput.trim();

  const roleIcon = (role: string) => {
    switch (role) {
      case "leader": return <Crown className="w-4 h-4 text-[hsl(var(--convoy-leader))]" />;
      case "sweep": return <Shield className="w-4 h-4 text-[hsl(var(--convoy-sweep))]" />;
      default: return <Eye className="w-4 h-4 text-[hsl(var(--convoy-follower))]" />;
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case "active": return "bg-primary/10 text-primary";
      case "off_route": return "bg-accent/10 text-accent";
      case "arrived": return "bg-primary/10 text-primary";
      case "disconnected": return "bg-muted text-muted-foreground";
      default: return "bg-muted text-muted-foreground";
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-pulse text-muted-foreground">Loading convoy...</div>
      </div>
    );
  }

  if (!convoy) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-4">
        <p className="text-muted-foreground">Convoy not found</p>
        <Button variant="outline" onClick={() => navigate("/")}>Go Home</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate("/")}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div>
              <h1 className="font-bold text-lg leading-tight">{convoy.name}</h1>
              <Badge variant={convoy.status === "active" ? "default" : "secondary"} className="text-xs">
                {convoy.status}
              </Badge>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => navigate(`/convoy/${id}/alerts`)}>
              <Bell className="w-4 h-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={copyCode} className="gap-2 font-mono">
              <Copy className="w-3 h-3" />
              {convoy.code}
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Destination */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <MapPin className="w-4 h-4 text-primary" />
              Destination
            </CardTitle>
          </CardHeader>
          <CardContent>
            {convoy.destination_address ? (
              <div className="space-y-3">
                <p className="font-medium">{convoy.destination_address}</p>
                <div className="flex flex-col gap-3">
                  <div className="relative w-full aspect-video overflow-hidden rounded-lg border">
                    {miniViewport ? (
                      <AppMap
                        className="absolute inset-0"
                        viewport={miniViewport}
                        onViewportChange={setMiniViewport}
                        dragPan={false}
                        dragRotate={false}
                        scrollZoom={false}
                        doubleClickZoom={false}
                        boxZoom={false}
                        touchZoomRotate={false}
                        keyboard={false}
                        attributionControl={false}
                      >
                        <MapMarker
                          longitude={miniViewport.center[0]}
                          latitude={miniViewport.center[1]}
                          anchor="bottom"
                        >
                          <MarkerContent>
                            <DestinationPreviewPin />
                          </MarkerContent>
                          <MarkerPopup className="min-w-[180px]">
                            <div className="space-y-1">
                              <p className="font-semibold">Destination</p>
                              <p className="text-xs text-muted-foreground">
                                {convoy.destination_address}
                              </p>
                            </div>
                          </MarkerPopup>
                        </MapMarker>
                      </AppMap>
                    ) : (
                      <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
                        Loading map...
                      </div>
                    )}
                  </div>
                  {isLeader && (
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button size="sm" variant="outline" className="gap-2 self-start">
                          <RefreshCw className="w-4 h-4" />
                          Change
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Update Destination</DialogTitle>
                          <DialogDescription>Enter a new destination address.</DialogDescription>
                        </DialogHeader>
                        <form onSubmit={handleSetDestination} className="space-y-4">
                          <div className="space-y-2">
                            <Label>Destination Address</Label>
                            <div className="relative">
                              <Input
                                placeholder="123 Main St, City, State"
                                value={destinationInput}
                                onChange={(e) => {
                                  setDestinationInput(e.target.value);
                                  setSelectedCoords(null);
                                }}
                                required
                              />
                              {destinationSuggestions.length > 0 && (
                                <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover shadow-lg">
                                  {destinationSuggestions.map((s, idx) => (
                                    <button
                                      key={`${s.display_name}-${idx}`}
                                      type="button"
                                      className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                                      onClick={() => void handleSelectSuggestion(s)}
                                    >
                                      <span className="min-w-0 flex-1">{s.display_name}</span>
                                      {s.category && (
                                        <Badge variant="outline" className="shrink-0 text-[10px]">
                                          {s.category}
                                        </Badge>
                                      )}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                            {searchingDest && (
                              <p className="text-[11px] text-muted-foreground">Searching…</p>
                            )}
                            {!destinationSuggestions.length && shouldShowQuickPicks && (
                              <div className="rounded-lg border bg-muted/30 p-3">
                                <p className="text-xs font-medium text-muted-foreground">
                                  Quick picks: Mindanao tourist spots
                                </p>
                                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                  {quickDestinationSuggestions.map((suggestion) => (
                                    <button
                                      key={suggestion.display_name}
                                      type="button"
                                      className="rounded-lg border bg-background px-3 py-2 text-left transition-colors hover:bg-muted"
                                      onClick={() => void handleSelectSuggestion(suggestion)}
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="line-clamp-2 text-sm font-medium">
                                          {suggestion.display_name}
                                        </span>
                                        {suggestion.category && (
                                          <Badge variant="outline" className="shrink-0 text-[10px]">
                                            {suggestion.category}
                                          </Badge>
                                        )}
                                      </div>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                          <Button type="submit" className="w-full" disabled={settingDest}>
                            {settingDest ? "Updating..." : "Update Destination"}
                          </Button>
                        </form>
                      </DialogContent>
                    </Dialog>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center py-4">
                <p className="text-muted-foreground mb-3">
                  {isLeader ? "Set a destination to get started" : "Waiting for leader to set destination"}
                </p>
                {isLeader && (
                  <div className="space-y-2 max-w-md mx-auto">
                    <form onSubmit={handleSetDestination} className="flex gap-2">
                      <div className="flex-1 relative">
                        <Input
                          placeholder="Enter destination address"
                          value={destinationInput}
                          onChange={(e) => {
                            setDestinationInput(e.target.value);
                            setSelectedCoords(null);
                          }}
                          required
                        />
                        {destinationSuggestions.length > 0 && (
                          <div className="absolute z-20 mt-1 w-full rounded-md border bg-popover shadow-lg max-h-56 overflow-auto">
                            {destinationSuggestions.map((s, idx) => (
                              <button
                                key={`${s.display_name}-${idx}`}
                                type="button"
                                className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                                onClick={() => void handleSelectSuggestion(s)}
                              >
                                <span className="min-w-0 flex-1">{s.display_name}</span>
                                {s.category && (
                                  <Badge variant="outline" className="shrink-0 text-[10px]">
                                    {s.category}
                                  </Badge>
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                        {searchingDest && (
                          <p className="text-[11px] text-muted-foreground mt-1">Searching…</p>
                        )}
                      </div>
                      <Button type="submit" disabled={settingDest} className="gap-2 shrink-0">
                        <MapPin className="w-4 h-4" />
                        Set
                      </Button>
                    </form>
                    {shouldShowQuickPicks && (
                      <div className="rounded-lg border bg-muted/30 p-3 text-left">
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <p className="text-xs font-medium text-muted-foreground">
                            Try a famous Mindanao destination
                          </p>
                          <Badge variant="secondary" className="text-[10px]">
                            Tourist picks
                          </Badge>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {quickDestinationSuggestions.map((suggestion) => (
                            <button
                              key={suggestion.display_name}
                              type="button"
                              className="rounded-lg border bg-background px-3 py-2 text-left transition-colors hover:bg-muted"
                              onClick={() => void handleSelectSuggestion(suggestion)}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="line-clamp-2 text-sm font-medium">
                                  {suggestion.display_name}
                                </span>
                                {suggestion.category && (
                                  <Badge variant="outline" className="shrink-0 text-[10px]">
                                    {suggestion.category}
                                  </Badge>
                                )}
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Members */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="w-4 h-4 text-primary" />
              Members ({members.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {members.map((member) => (
              <div
                key={member.id}
                className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
              >
                <div className="flex items-center gap-3">
                  {roleIcon(member.role)}
                  <div>
                    <p className="font-medium text-sm">
                      {member.profiles?.display_name || "Unknown"}
                      {member.user_id === user?.id && (
                        <span className="text-muted-foreground ml-1">(you)</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground capitalize">{member.role}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-1 rounded-full ${statusColor(member.status)}`}>
                    {member.status.replace("_", " ")}
                  </span>
                  {isLeader && member.user_id !== user?.id && (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => handleRemoveMember(member.id, member.user_id)}
                        title="Remove member"
                      >
                        <UserMinus className="w-3 h-3" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex flex-wrap gap-3">
          {isLeader && convoy.status === "forming" && (
            <Button onClick={handleStartConvoy} className="gap-2">
              <Play className="w-4 h-4" />
              Start Convoy
            </Button>
          )}
          {isLeader && convoy.status === "active" && (
            <>
              <Dialog open={regroupOpen} onOpenChange={setRegroupOpen}>
                <DialogTrigger asChild>
                  <Button variant="destructive" className="gap-2">
                    <Radio className="w-4 h-4" />
                    Call Regroup
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                      <AlertTriangle className="w-5 h-5 text-destructive" />
                      Call Regroup
                    </DialogTitle>
                    <DialogDescription>
                      Send a regroup alert to all convoy members. They'll be notified to pull over safely.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>Message (optional)</Label>
                      <Input
                        placeholder="Pull over at the next rest stop"
                        value={regroupMessage}
                        onChange={(e) => setRegroupMessage(e.target.value)}
                      />
                    </div>
                    <Button onClick={handleCallRegroup} variant="destructive" className="w-full gap-2">
                      <Radio className="w-4 h-4" />
                      Send Regroup Alert
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
              <Button variant="secondary" onClick={handleEndConvoy} className="gap-2">
                <Square className="w-4 h-4" />
                End Trip
              </Button>
            </>
          )}
          <Button variant="outline" onClick={() => navigate(`/convoy/${id}/map`)} className="gap-2">
            <Navigation className="w-4 h-4" />
            Full Map
          </Button>
          <Button variant="outline" onClick={() => navigate(`/convoy/${id}/alerts`)} className="gap-2">
            <Bell className="w-4 h-4" />
            Alerts
          </Button>
          {!isLeader && (
            <Button variant="destructive" size="sm" onClick={handleLeaveConvoy} className="gap-2">
              <UserMinus className="w-4 h-4" />
              Leave
            </Button>
          )}
        </div>
      </main>
    </div>
  );
}
