import type { TextKey } from './i18n';

export interface Bootstrap {
  staff: { username: string; branch_code: string } | null;
  customer: { full_name: string } | null;
  activeDepositId: string | null;
}
export interface Account {
  id: string;
  account_number: string;
  full_name: string;
  branch_code: string;
}
export interface Denomination { denomination: number; quantity: number }
export type Status = 'WAITING' | 'CALLED' | 'ACKNOWLEDGED' | 'REJECTED' | 'NO_SHOW';
export interface Deposit {
  id: string;
  token: string;
  token_number: number;
  business_date: string;
  full_name: string;
  account_number: string;
  branch_code: string;
  status: Status;
  total_amount: string;
  ahead: number;
  created_at: string;
  rejection_code: TextKey | null;
  rejection_note: string | null;
  denominations: Denomination[];
  events: { event_type: TextKey; created_at: string; note: string | null }[];
}
export interface QueueData {
  queue: {
    id: string; token_number: number; business_date: string; status: Status;
    created_at: string; total_amount: string; mine: boolean;
  }[];
  summary: { waiting: number; called: number; acknowledged: number; rejected: number };
  activeId: string | null;
  staff: { username: string; branch_code: string };
  updatedAt: string;
}
