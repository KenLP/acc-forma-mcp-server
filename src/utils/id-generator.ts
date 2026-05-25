import { ulid } from 'ulid';

export const generateEventId = (): string => `evt_${ulid()}`;
export const generateApprovalToken = (): string => `appr_${ulid()}`;
