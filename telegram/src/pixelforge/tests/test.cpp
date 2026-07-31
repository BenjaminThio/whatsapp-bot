#include <iostream>
using namespace std;

int main()
{
    int *a; // nullptr ? memory adddress | value
    int b = 10;
    int d = 50;

    a = &b;
    *a = 10;

    a = &d;
    *a = 70;

    int &c = b; // refernce to a memory address | pointing to that address
    b = 10; // assign value to that memory
    b = d; // assign value of d to that memory

    cout << a << endl; // memory address
    cout << *a << endl; // value
    return 0;
}