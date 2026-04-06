import type { Tables, TablesInsert, Enums } from "@/integrations/supabase/types";

// Database row types
export type Convoy = Tables<"convoys">;
export type ConvoyMember = Tables<"convoy_members">;
export type MemberLocation = Tables<"member_locations">;
export type ConvoyWaypoint = Tables<"convoy_waypoints">;
export type ConvoyAlert = Tables<"convoy_alerts">;
export type TripEvent = Tables<"trip_events">;
export type Profile = Tables<"profiles">;

// Insert types
export type ConvoyInsert = TablesInsert<"convoys">;
export type ConvoyMemberInsert = TablesInsert<"convoy_members">;
export type MemberLocationInsert = TablesInsert<"member_locations">;

// Enum types
export type ConvoyStatus = Enums<"convoy_status">;
export type ConvoyMemberRole = Enums<"convoy_member_role">;
export type ConvoyMemberStatus = Enums<"convoy_member_status">;
export type AlertType = Enums<"alert_type">;
export type WaypointType = Enums<"waypoint_type">;
export type WaypointStatus = Enums<"waypoint_status">;

// Extended types for UI
export type ConvoyMemberWithProfile = ConvoyMember & {
  profile?: Profile;
  location?: MemberLocation;
};

// Event contract for React Native / CarPlay alignment
export const CONVOY_EVENTS = {
  CREATED: "convoy.created",
  MEMBER_JOINED: "convoy.member_joined",
  MEMBER_LEFT: "convoy.member_left",
  DESTINATION_SET: "convoy.destination_set",
  ROUTE_UPDATED: "convoy.route_updated",
  MEMBER_LOCATION_UPDATED: "convoy.member_location_updated",
  MEMBER_OFFROUTE: "convoy.member_offroute",
  REGROUP_CALLED: "convoy.regroup_called",
  MEMBER_ARRIVED: "convoy.member_arrived",
  LEADER_CHANGED: "convoy.leader_changed",
  CONVOY_STARTED: "convoy.started",
  CONVOY_COMPLETED: "convoy.completed",
} as const;

export type ConvoyEventType = (typeof CONVOY_EVENTS)[keyof typeof CONVOY_EVENTS];
