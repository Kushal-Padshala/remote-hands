export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      approvals: {
        Row: {
          action_kind: string
          created_at: string
          decided_at: string | null
          decision: string
          expires_at: string
          frame_path: string | null
          id: string
          risk: string
          summary: string
          task_id: string
          tool_payload: Json
          user_id: string
        }
        Insert: {
          action_kind: string
          created_at?: string
          decided_at?: string | null
          decision?: string
          expires_at: string
          frame_path?: string | null
          id?: string
          risk: string
          summary: string
          task_id: string
          tool_payload?: Json
          user_id: string
        }
        Update: {
          action_kind?: string
          created_at?: string
          decided_at?: string | null
          decision?: string
          expires_at?: string
          frame_path?: string | null
          id?: string
          risk?: string
          summary?: string
          task_id?: string
          tool_payload?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "approvals_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          created_at: string
          id: number
          kind: string
          payload: Json
          seq: number
          task_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: never
          kind: string
          payload?: Json
          seq: number
          task_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: never
          kind?: string
          payload?: Json
          seq?: number
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "events_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      machines: {
        Row: {
          agy_version: string | null
          created_at: string
          daemon_version: string | null
          hostname: string
          id: string
          last_seen_at: string | null
          name: string
          status: string
          user_id: string
        }
        Insert: {
          agy_version?: string | null
          created_at?: string
          daemon_version?: string | null
          hostname: string
          id?: string
          last_seen_at?: string | null
          name: string
          status?: string
          user_id: string
        }
        Update: {
          agy_version?: string | null
          created_at?: string
          daemon_version?: string | null
          hostname?: string
          id?: string
          last_seen_at?: string | null
          name?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      tasks: {
        Row: {
          conversation_id: string | null
          created_at: string
          effort: string | null
          error: string | null
          finished_at: string | null
          id: string
          kind: string
          machine_id: string
          mode: string
          model: string | null
          parent_task_id: string | null
          prompt: string
          result_summary: string | null
          started_at: string | null
          status: string
          user_id: string
          workspace_path: string | null
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string
          effort?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          kind?: string
          machine_id: string
          mode?: string
          model?: string | null
          parent_task_id?: string | null
          prompt: string
          result_summary?: string | null
          started_at?: string | null
          status?: string
          user_id: string
          workspace_path?: string | null
        }
        Update: {
          conversation_id?: string | null
          created_at?: string
          effort?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          kind?: string
          machine_id?: string
          mode?: string
          model?: string | null
          parent_task_id?: string | null
          prompt?: string
          result_summary?: string | null
          started_at?: string | null
          status?: string
          user_id?: string
          workspace_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_machine_id_fkey"
            columns: ["machine_id"]
            isOneToOne: false
            referencedRelation: "machines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_parent_task_id_fkey"
            columns: ["parent_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      machine_belongs_to_current_user: {
        Args: { machine: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

