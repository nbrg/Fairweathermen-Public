import { importFixturesFromExcel } from '../server/importFixtures';
import path from 'path';

async function main() {
  try {
    const excelPath = path.join(process.cwd(), 'attached_assets', 'epl fixtures_1754919412481.xlsx');
    console.log('Starting fixture import from:', excelPath);
    
    await importFixturesFromExcel(excelPath);
    
    console.log('Fixture import completed successfully!');
  } catch (error) {
    console.error('Error importing fixtures:', error);
    process.exit(1);
  }
}

main();