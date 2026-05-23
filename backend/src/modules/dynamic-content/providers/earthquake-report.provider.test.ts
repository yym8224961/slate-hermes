import { describe, expect, it } from 'bun:test';
import { parseEarthquakeSubaoRows } from './earthquake-report.provider';

describe('parseEarthquakeSubaoRows', () => {
  it('parses official data.earthquake.cn table rows', () => {
    const html = `
      <tr id="earthquake_subao_guid_catalog_tr_0">
        <td><div class='cls-data-content-list'>1</div></td>
        <td><div class='cls-data-content-list'>2026-5-23 11:27:06</div></td>
        <td><div class='cls-data-content-list'>113.03</div></td>
        <td><div class='cls-data-content-list'>39.96</div></td>
        <td><div class='cls-data-content-list'>-</div></td>
        <td><div class='cls-data-content-list'>3.2</div></td>
        <td><div class='cls-data-content-list'>山西大同市云冈区</div></td>
        <td><div class='cls-data-content-list'>天然地震</div></td>
      </tr>
      <tr id="earthquake_subao_guid_catalog_tr_1">
        <td><div class='cls-data-content-list'>2</div></td>
        <td><div class='cls-data-content-list'>2026-5-23 01:16:27</div></td>
        <td><div class='cls-data-content-list'>90.23</div></td>
        <td><div class='cls-data-content-list'>33.47</div></td>
        <td><div class='cls-data-content-list'>10</div></td>
        <td><div class='cls-data-content-list'>4.1</div></td>
        <td><div class='cls-data-content-list'>青海海西州唐古拉地区</div></td>
        <td><div class='cls-data-content-list'>天然地震</div></td>
      </tr>
    `;

    expect(parseEarthquakeSubaoRows(html)).toEqual([
      {
        id: '1',
        occurredAt: '2026-5-23 11:27:06',
        longitude: '113.03',
        latitude: '39.96',
        depthKm: '-',
        magnitude: '3.2',
        location: '山西大同市云冈区',
        eventType: '天然地震',
      },
      {
        id: '2',
        occurredAt: '2026-5-23 01:16:27',
        longitude: '90.23',
        latitude: '33.47',
        depthKm: '10',
        magnitude: '4.1',
        location: '青海海西州唐古拉地区',
        eventType: '天然地震',
      },
    ]);
  });
});
