import copy
import unittest
from mineru_normalize import normalize, NormalizationError


def document(html="<table><tr><td>Item</td><td>Quantity</td></tr><tr><td>Sample</td><td>3</td></tr></table>"):
    return {"extensions":{"docvortex_layout":{"pages":[{"page_idx":0,"width_pt":612,"height_pt":792}]}},
            "pages":[{"page_idx":0,"blocks":[{"type":"table","index":7,"bbox":[.1,.2,.8,.9],"content":[{"type":"table_body","content":html}]}]}]}


class NormalizeTest(unittest.TestCase):
    def test_native_tables_empty_cells_and_spans(self):
        data=document('<table><tr><td rowspan="2">Heading</td><td></td><td colspan="2">Merged</td></tr><tr><td>2</td><td>3</td><td>4</td></tr></table>')
        result=normalize(data,[1]);table=result['pages'][0]['tables'][0]
        self.assertEqual(table['sourceLocator'],'page:1/block:7/table:0')
        self.assertEqual(table['bbox'],{'left':.1,'top':.2,'right':.8,'bottom':.9})
        self.assertEqual((table['rowCount'],table['columnCount']),(2,4))
        self.assertEqual(table['cells'][1]['text'],'')
        self.assertEqual(table['cells'][2]['colSpan'],2)
        self.assertEqual(table['cells'][3]['col'],1)
        self.assertTrue(all('bbox' not in c for c in table['cells']))
        self.assertFalse(table['continuesPrevious'])
        self.assertEqual(result['pages'][0]['blocks'][0]['tableId'],table['id'])

    def test_selected_original_page_numbers_and_order(self):
        data=document();second=copy.deepcopy(data['pages'][0]);second['page_idx']=4
        second['blocks'][0]['continues_prev']=True;data['pages'].append(second)
        result=normalize(data,[5,1])
        self.assertEqual([p['page'] for p in result['pages']],[5,1])
        self.assertTrue(result['pages'][0]['tables'][0]['continuesPrevious'])
        self.assertTrue(result['pages'][0]['tables'][0]['id'].startswith('p5-'))
        with self.assertRaises(NormalizationError):normalize(document(),[2])

    def test_empty_recognition_is_warning_not_claimed_blank(self):
        data={'pages':[{'page_idx':0,'blocks':[]}]}
        self.assertEqual(normalize(data,[1])['pages'][0]['warnings'],['NO_RECOGNIZED_CONTENT'])
        result=normalize(document('<table></table>'),[1])['pages'][0]
        self.assertEqual(result['warnings'],['NO_RECOGNIZED_CONTENT'])
        self.assertEqual(result['tables'][0]['rowCount'],0)
        self.assertEqual(result['tables'][0]['columnCount'],0)

    def test_cell_and_expanded_slot_budgets(self):
        for html in ['<table><tr><td>'+'x'*65537+'</td></tr></table>',
                     '<table><tr><td rowspan="1000" colspan="1000">x</td></tr></table>',
                     '<table>'+('<tr>'+('<td>x</td>'*6)+'</tr>')*835+'</table>']:
            with self.assertRaises(NormalizationError) as raised:normalize(document(html),[1])
            self.assertEqual(raised.exception.code,'PARSER_LIMIT')

    def test_malformed_geometry_and_table_are_rejected(self):
        for box in [[0,0,2,1],[.8,0,.2,1],[float('nan'),0,1,1]]:
            data=document();data['pages'][0]['blocks'][0]['bbox']=box
            with self.assertRaises(NormalizationError):normalize(data,[1])
        for html in ['<table><tr><td colspan="0">x</td></tr></table>',
                     '<table><tr><td>x', '<table><table></table></table>',
                     '<table></table><table></table>']:
            with self.assertRaises(NormalizationError):normalize(document(html),[1])

    def test_only_native_text_and_normalized_geometry_exported(self):
        data=document();data['metadata']={'document':{'authors':['private metadata']}}
        data['pages'][0]['blocks'].append({'type':'text','bbox':None,'content':[{'content':'Actual text'}],
                                           'image_path':'private-host-file','api_key':''})
        result=normalize(data,[1]);self.assertEqual(result['pages'][0]['blocks'][1]['text'],'Actual text')
        self.assertNotIn('private-',str(result));self.assertNotIn('authors',str(result))


if __name__=='__main__':unittest.main()
