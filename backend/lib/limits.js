export const PLAN_LIMITS = {
  free: {
    portfolioCollections: 1,
    portfolioPhotos: 10
  },
  premium: {
    portfolioCollections: 10,
    portfolioPhotos: 250
  }
};

export function planForPhotographer(photographerProfile) {
  return photographerProfile?.subscription_status === 'active' ? 'premium' : 'free';
}

export function limitsForPlan(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}
