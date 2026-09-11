/**
 * Hand-written scenarios, one file per domain.
 *
 * Every fixture pins its own `context.now`, so a scenario decides the same way
 * today as it will in two years. That is not a testing convenience — it is the
 * same property that makes a stored decision replayable, exercised on the
 * inputs a reader can actually see.
 */

import type { ActionEnvelope, Domain, Outcome } from '@/core/types'
import deployRaw from './deploy.json'
import moderationRaw from './moderation.json'
import refundsRaw from './refunds.json'

export type Fixture = {
  id: string
  title: string
  /** The verdict this scenario exists to produce. Asserted in tests/kernel.spec.ts. */
  expect: Outcome
  /** Why this scenario is in the set. Shown in the console UI. */
  note: string
  envelope: ActionEnvelope
}

export const fixtures: Record<Domain, Fixture[]> = {
  refunds: refundsRaw as unknown as Fixture[],
  deploy: deployRaw as unknown as Fixture[],
  moderation: moderationRaw as unknown as Fixture[],
}

export const allFixtures: Fixture[] = [
  ...fixtures.refunds,
  ...fixtures.deploy,
  ...fixtures.moderation,
]

export function fixtureById(id: string): Fixture | undefined {
  return allFixtures.find((f) => f.id === id)
}
