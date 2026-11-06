const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const config = require('./config');
const app = require('./app');
const { seed, DEMO_PASSWORD } = require('./seed/seed');

(async () => {
  try {
    console.log('Starting in-memory MongoDB instance...');
    const mongo = await MongoMemoryServer.create();
    const uri = mongo.getUri();
    console.log(`In-memory MongoDB started at: ${uri}`);
    await mongoose.connect(uri);

    console.log('Seeding demo data...');
    await seed({ log: console.log });

    app.listen(config.port, () => {
      console.log('\n=============================================================');
      console.log(`FlowCare is live at http://localhost:${config.port}`);
      console.log(`Demo accounts (Password: ${DEMO_PASSWORD}):`);
      console.log('  - Administrator:     admin@demo.local');
      console.log('  - Resource Manager:  resources@demo.local');
      console.log('  - Doctor:            doctor@demo.local');
      console.log('  - Nurse:             nurse@demo.local');
      console.log('  - Receptionist:      reception@demo.local');
      console.log('=============================================================\n');
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
})();
