import unittest
from chef_ai_workspace.correction_memory import Correction, retrieve_suggestions

class Store:
    def __init__(self, items):self.items=items;self.calls=[]
    def find_confirmed(self, owner_id, context, phrases, limit):
        self.calls.append((owner_id,context,phrases,limit))
        return self.items

class MemoryTests(unittest.TestCase):
    def test_user_confirmed_exact_context_only(self):
        store=Store([Correction("澱粉","片栗粉","recipe:one",True),
                     Correction("澱粉","小麦粉","recipe:two",True),
                     Correction("澱粉","コーンスターチ","recipe:one",False)])
        result=retrieve_suggestions(store,owner_id="chef",context="recipe:one",phrases=("澱粉","澱粉"))
        self.assertEqual(result,[{"heard":"澱粉","candidate":"片栗粉","context":"recipe:one"}])
        self.assertEqual(store.calls,[("chef","recipe:one",("澱粉",),5)])
    def test_no_input_skips_database(self):
        store=Store([])
        self.assertEqual(retrieve_suggestions(store,owner_id="chef",context="recipe:one",phrases=("",)),[])
        self.assertEqual(store.calls,[])
    def test_invalid_correction_rejected(self):
        with self.assertRaises(ValueError):Correction(" ","x","recipe:one",True)

if __name__=="__main__":unittest.main()
