const firebaseDB = require('../server/firebaseDb.js');
const { initializeFirebase } = require('../server/firebase.js');

async function seedPlans() {
  try {
    initializeFirebase();
    console.log('🌱 Seeding subscription plans...');
    
    const subscriptionPlans = [
      {
        name: '1 Day ❗️ Recommended for Friday Stream',
        priceCents: 1000,
        currency: 'USD',
        durationDays: 1,
        maxCodesPerDay: 999,
        isActive: true,
      },
      {
        name: '1 Week 💵',
        priceCents: 2200,
        currency: 'USD',
        durationDays: 7,
        maxCodesPerDay: 999,
        isActive: true,
      },
      {
        name: '1 Month 💼',
        priceCents: 5500,
        currency: 'USD',
        durationDays: 30,
        maxCodesPerDay: 999,
        isActive: true,
      },
      {
        name: '3 Months 💎',
        priceCents: 10000,
        currency: 'USD',
        durationDays: 90,
        maxCodesPerDay: 999,
        isActive: true,
      },
      {
        name: '6 Months 💎',
        priceCents: 16000,
        currency: 'USD',
        durationDays: 180,
        maxCodesPerDay: 999,
        isActive: true,
      },
      {
        name: '1 Year 💎',
        priceCents: 25000,
        currency: 'USD',
        durationDays: 365,
        maxCodesPerDay: 999,
        isActive: true,
      },
      {
        name: 'Lifetime 💎',
        priceCents: 40000,
        currency: 'USD',
        durationDays: 36500,
        maxCodesPerDay: 999,
        isActive: true,
      },
    ];
    
    for (const plan of subscriptionPlans) {
      const createdPlan = await firebaseDB.createPlan(plan);
      console.log(`✅ Created plan: ${plan.name} - $${plan.priceCents/100} (ID: ${createdPlan.id})`);
    }
    
    console.log('🎉 Plans seeded successfully!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error seeding plans:', error);
    process.exit(1);
  }
}

seedPlans();
