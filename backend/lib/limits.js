export const PLAN_LIMITS = {
  free: {
    portfolioCollections: Infinity,
    portfolioPhotos: 6,
    packages: 4
  },
  basic: {
    portfolioCollections: Infinity,
    portfolioPhotos: 25,
    packages: Infinity
  },
  premium: {
    portfolioCollections: Infinity,
    portfolioPhotos: 40,
    packages: Infinity
  }
};

export function planForPhotographer(photographerProfile) {
  if (photographerProfile?.subscription_status !== 'active') return 'free';
  return photographerProfile?.subscription_plan === 'premium' ? 'premium' : 'basic';
}

export function limitsForPlan(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}
